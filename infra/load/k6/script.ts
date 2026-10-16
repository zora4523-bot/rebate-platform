import { check } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http, { type Response } from 'k6/http';
import {
  buildOptions,
  resolveBaseUrls,
  scenarioNames,
  type LoadConfig,
  type ScenarioName,
} from './options.ts';

interface SuiteConfig extends LoadConfig {
  app_version: string;
  requests: {
    convert: Record<string, unknown>;
    agent_sse: { text: string; context: Record<string, unknown> };
  };
}

interface Fixture {
  app_id: string;
  device_id: string;
  access_token: string;
  install_secret: string;
  session_id: string;
}

interface Fixtures {
  users: Fixture[];
  admin_token: string;
  // Supplied by the local sync implementation, never guessed from a platform API.
  sync_body: Record<string, unknown>;
}

const config = JSON.parse(open('./config.json')) as SuiteConfig;
const bases = resolveBaseUrls(config, __ENV);
export const options = buildOptions(config);
// Mount a local-only fixture file; nothing in this repository contains credentials.
const fixtures = JSON.parse(open('./fixtures.json')) as Fixtures;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Init checks happen before k6 starts any requests, including on malformed fixtures.
const neededUsers = scenarioNames.reduce((sum, name) => {
  const s = options.scenarios[name]!;
  return sum + (s.maxVUs ?? Math.max(...s.stages.map((stage) => stage.target)));
}, 0);
if (!isRecord(fixtures) || !Array.isArray(fixtures.users) || fixtures.users.length < neededUsers) {
  throw new Error(
    'fixtures.json needs at least ' + neededUsers + ' local users, one per possible VU',
  );
}
const sessions = new Set<string>();
const devices = new Set<string>();
for (const user of fixtures.users) {
  if (
    !isRecord(user) ||
    !['app_id', 'device_id', 'access_token', 'install_secret', 'session_id'].every(
      (key) => typeof user[key] === 'string' && /^[\x21-\x7e]+$/.test(user[key]),
    )
  ) {
    throw new Error(
      'Each fixture needs app_id, device_id, access_token, install_secret and session_id',
    );
  }
  if (!/^[a-z0-9_]{1,32}$/.test(user.app_id) || !/^[a-zA-Z0-9_-]+$/.test(user.session_id)) {
    throw new Error('Invalid fixture app_id or session_id');
  }
  if (sessions.has(user.session_id) || devices.has(user.device_id))
    throw new Error('Fixtures must use distinct sessions and devices');
  sessions.add(user.session_id);
  devices.add(user.device_id);
}
if (
  typeof fixtures.admin_token !== 'string' ||
  !/^[\x21-\x7e]+$/.test(fixtures.admin_token) ||
  !isRecord(fixtures.sync_body) ||
  Object.keys(fixtures.sync_body).length === 0
) {
  throw new Error(
    'fixtures.json needs a local admin_token and a nonempty sync_body from the sync contract',
  );
}
if (
  !/^\d+\.\d+\.\d+$/.test(config.app_version) ||
  !isRecord(config.requests?.convert) ||
  typeof config.requests?.agent_sse?.text !== 'string' ||
  !isRecord(config.requests.agent_sse.context)
) {
  throw new Error('config.json needs app_version and convert / agent_sse request parameters');
}

function randomHex(): string {
  return Array.from(new Uint8Array(crypto.randomBytes(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function uuid(): string {
  const chars = randomHex().split('');
  chars[12] = '4';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function businessOk(response: Response): boolean {
  if (response.status !== 200 || response.body === null) return false;
  try {
    const body: unknown = JSON.parse(response.body);
    return isRecord(body) && body['code'] === 0 && 'data' in body;
  } catch {
    return false;
  }
}

function streamOk(response: Response): boolean {
  const contentType =
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ??
    '';
  if (
    response.status !== 200 ||
    !/^text\/event-stream(?:;|$)/i.test(contentType) ||
    response.body === null
  )
    return false;
  // k6/http buffers the body: this validates completion but does not timestamp individual frames.
  const blocks = response.body.replace(/\r\n/g, '\n').split('\n\n');
  let meta = false;
  let done = false;
  let previousId = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') continue; // SSE comments / heartbeat
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const id = Number(
      lines
        .find((line) => line.startsWith('id:'))
        ?.slice(3)
        .trim(),
    );
    if (done || !Number.isSafeInteger(id) || id <= previousId || event === 'error') return false;
    previousId = id;
    try {
      const payload: unknown = JSON.parse(data);
      if (!isRecord(payload)) return false;
      if (!meta && event !== 'meta') return false;
      if (event === 'meta') {
        if (meta || payload['duplicate'] === true) return false;
        meta = true;
      }
      if (event === 'done') done = true;
    } catch {
      return false;
    }
  }
  return meta && done;
}

function run(name: ScenarioName): void {
  const s = config.scenarios[name]!;
  const user = fixtures.users[exec.vu.idInTest - 1];
  if (user === undefined)
    exec.test.abort('No fixture for this VU; distributed execution needs a complete fixture set');
  const path = s.path.replace('{session_id}', user.session_id);
  const data =
    name === 'convert'
      ? config.requests.convert
      : name === 'agent_sse'
        ? { ...config.requests.agent_sse, client_msg_id: uuid() }
        : name === 'sync'
          ? fixtures.sync_body
          : null;
  const body = data === null ? null : JSON.stringify(data);
  const headers: Record<string, string> = {
    'X-App-Id': user.app_id,
    'X-Platform': 'h5',
    'X-App-Version': config.app_version,
    'X-Device-Id': user.device_id,
    Authorization: 'Bearer ' + (name === 'sync' ? fixtures.admin_token : user.access_token),
    Accept: name === 'agent_sse' ? 'text/event-stream' : 'application/json',
  };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = uuid();
  }
  if (name === 'convert') {
    // Transport timestamp is the k6 wall clock; never a business / accounting clock.
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomHex();
    headers['X-Timestamp'] = ts;
    headers['X-Nonce'] = nonce;
    headers['X-Sign'] = crypto.hmac(
      'sha256',
      user.install_secret,
      [s.method, path, ts, nonce, crypto.sha256(body ?? '', 'hex')].join('\n'),
      'hex',
    );
  }
  const response = http.request(s.method, bases[s.service] + path, body, {
    headers,
    redirects: 0,
    timeout: s.request_timeout ?? '60s',
    responseType: 'text',
    tags: { name },
    responseCallback: http.expectedStatuses(200),
  });
  check(response, {
    [name + ': valid business response']: name === 'agent_sse' ? streamOk : businessOk,
  });
}

export function search(): void {
  run('search');
}
export function convert(): void {
  run('convert');
}
export function agent_sse(): void {
  run('agent_sse');
}
export function sync(): void {
  run('sync');
}
