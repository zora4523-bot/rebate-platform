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
    agent_sse: { text: string; context?: Record<string, unknown> };
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
// Context is optional, but when present the contract permits exactly one entry context.
function validContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (typeof value['product_key'] === 'string')
    return [...value['product_key']].length >= 3 && [...value['product_key']].length <= 128;
  if (typeof value['order_id'] === 'string')
    return [...value['order_id']].length >= 1 && [...value['order_id']].length <= 64;
  return (
    typeof value['text'] === 'string' &&
    [...value['text']].length >= 1 &&
    [...value['text']].length <= 2000
  );
}

if (
  !/^\d+\.\d+\.\d+$/.test(config.app_version) ||
  !isRecord(config.requests?.convert) ||
  !isRecord(config.requests?.agent_sse) ||
  typeof config.requests?.agent_sse?.text !== 'string' ||
  config.requests.agent_sse.text.length === 0 ||
  !Object.keys(config.requests.agent_sse).every((key) => key === 'text' || key === 'context') ||
  !validContext(config.requests.agent_sse.context)
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
  if (response.status !== 200 || response.error_code || response.body === null) return false;
  try {
    const body: unknown = JSON.parse(response.body);
    return isRecord(body) && body['code'] === 0 && 'data' in body;
  } catch {
    return false;
  }
}

function streamOk(response: Response, sessionId: string): boolean {
  const contentType =
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ??
    '';
  if (
    response.status !== 200 ||
    response.error_code ||
    !/^text\/event-stream(?:;|$)/i.test(contentType) ||
    response.body === null
  )
    return false;
  // k6/http buffers the body: this validates completion but does not timestamp individual frames.
  const blocks = response.body.replace(/\r\n?/g, '\n').split('\n\n');
  // An event without its final empty line was never dispatched by an SSE client.
  const tail = blocks.pop()!;
  if (tail.split('\n').some((line) => line !== '' && !line.startsWith(':'))) return false;
  let meta = false;
  let done = false;
  let previousId = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '') {
      if (lines.some((line) => line !== '' && !line.startsWith(':'))) return false;
      continue; // SSE comments / heartbeat
    }
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const rawId =
      lines
        .find((line) => line.startsWith('id:'))
        ?.slice(3)
        .trim() ?? '';
    const id = Number(rawId);
    if (
      done ||
      !/^[1-9][0-9]*$/.test(rawId) ||
      !Number.isSafeInteger(id) ||
      id <= previousId ||
      !['meta', 'text.delta', 'tool.status', 'card', 'suggestions', 'done'].includes(event ?? '')
    )
      return false;
    previousId = id;
    try {
      const payload: unknown = JSON.parse(data);
      if (!isRecord(payload)) return false;
      if (!meta && event !== 'meta') return false;
      if (event === 'meta') {
        if (
          meta ||
          payload['session_id'] !== sessionId ||
          (payload['duplicate'] !== undefined && payload['duplicate'] !== false) ||
          !['run_id', 'message_id', 'prompt_version', 'model_label', 'ai_label'].every(
            (key) => typeof payload[key] === 'string' && payload[key].length > 0,
          )
        )
          return false;
        meta = true;
      }
      if (['text.delta', 'tool.status', 'card'].includes(event ?? '') && payload['seq'] !== id)
        return false;
      if (event === 'done') {
        // Only a normal completion counts as a successful capacity sample.
        if (
          payload['finish_reason'] !== 'stop' ||
          typeof payload['quota_left'] !== 'number' ||
          !Number.isInteger(payload['quota_left']) ||
          payload['quota_left'] < 0
        )
          return false;
        done = true;
      }
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
  const path = s.path.replace('{id}', user.session_id);
  const data =
    name === 'convert'
      ? config.requests.convert
      : name === 'agent_sse'
        ? { ...config.requests.agent_sse, client_msg_id: uuid() }
        : null;
  const body = data === null ? null : JSON.stringify(data);
  const headers: Record<string, string> = {
    'X-App-Id': user.app_id,
    'X-Platform': 'h5',
    'X-App-Version': config.app_version,
    'X-Device-Id': user.device_id,
    Authorization: 'Bearer ' + user.access_token,
    Accept: name === 'agent_sse' ? 'text/event-stream' : 'application/json',
  };
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  if (name === 'convert') {
    headers['Idempotency-Key'] = uuid();
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
    [name + ': valid business response']: (value) =>
      name === 'agent_sse' ? streamOk(value, user.session_id) : businessOk(value),
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
