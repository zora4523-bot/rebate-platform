// Shared helpers of the QA-06b load-stub rule tests (规划/05 QA-06; 规划/02 §6.2 录制回放;
// 09 README §0.2 hard rule 5). Nothing here listens, starts a container or goes to the network:
// WireMock is represented by its JSON mapping format and the small matcher below.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LoadPlatform,
  LoadStubMapping,
  LoadStringMatcher,
  UnionRecordingInput,
} from '../../../../infra/load/wiremock/stubs.ts';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const RECORDINGS = join(ROOT, 'fixtures/union-recordings');
export const PLATFORMS: readonly LoadPlatform[] = ['taobao', 'jd', 'pdd'];
export const BAILIAN_PATH = '/bailian/compatible-mode/v1/chat/completions';

/** Repository file text, or '' when the file does not exist yet (an assertion then fails). */
export function repoText(path: string): string {
  const file = join(ROOT, path);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Every file under a repository directory (relative paths), [] when it does not exist. */
export function repoFiles(dir: string): string[] {
  const base = join(ROOT, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((entry) => statSync(join(base, entry)).isFile())
    .map((entry) => join(dir, entry));
}

/** The synthetic B1-04c samples, read straight from disk (fresh objects on every call). */
export function fixtureRecordings(): UnionRecordingInput[] {
  return PLATFORMS.map((platform) => {
    const dir = join(RECORDINGS, platform, 'synthetic-smoke');
    return {
      platform,
      scenario: 'synthetic-smoke',
      recording: JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8')) as unknown,
      provenance: JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8')) as unknown,
    };
  });
}

export interface Probe {
  method: string;
  /** Path plus query string. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

function strMatch(m: LoadStringMatcher, value: string | undefined): boolean {
  if ('equalTo' in m) return value === m.equalTo;
  if ('contains' in m) return value !== undefined && value.includes(m.contains);
  return value === undefined || !value.includes(m.doesNotContain);
}

function requestMatches(m: LoadStubMapping, probe: Probe): boolean {
  const r = m.request;
  if (r.method !== 'ANY' && r.method !== probe.method) return false;
  const path = probe.url.split('?', 1)[0] ?? '';
  if (r.url !== undefined && r.url !== probe.url) return false;
  if (r.urlPath !== undefined && r.urlPath !== path) return false;
  if (r.urlPathPattern !== undefined && !new RegExp(`^(?:${r.urlPathPattern})$`).test(path)) {
    return false;
  }
  const headers = Object.entries(probe.headers ?? {});
  for (const [name, matcher] of Object.entries(r.headers ?? {})) {
    const value = headers.find(([h]) => h.toLowerCase() === name.toLowerCase())?.[1];
    if (!strMatch(matcher, value)) return false;
  }
  return (r.bodyPatterns ?? []).every((p) => strMatch(p, probe.body));
}

/**
 * A stateful WireMock stand-in: every scenario starts in `Started`; a matching stub must be in its
 * required state; the lowest priority number wins (a tie is 'ambiguous'); `newScenarioState` moves
 * the scenario on.
 */
export function wiremock(mappings: readonly LoadStubMapping[]) {
  const states = new Map<string, string>();
  return (probe: Probe): LoadStubMapping | null | 'ambiguous' => {
    const hits = mappings.filter(
      (m) =>
        requestMatches(m, probe) &&
        (m.scenarioName === undefined ||
          m.requiredScenarioState === undefined ||
          (states.get(m.scenarioName) ?? 'Started') === m.requiredScenarioState),
    );
    if (hits.length === 0) return null;
    const best = Math.min(...hits.map((m) => m.priority));
    const top = hits.filter((m) => m.priority === best);
    if (top.length !== 1) return 'ambiguous';
    const hit = top[0] as LoadStubMapping;
    if (hit.scenarioName !== undefined && hit.newScenarioState !== undefined) {
      states.set(hit.scenarioName, hit.newScenarioState);
    }
    return hit;
  };
}

const TOP = ['id', 'name', 'priority', 'scenarioName', 'requiredScenarioState', 'newScenarioState'];
const REQ = ['method', 'url', 'urlPath', 'urlPathPattern', 'headers', 'bodyPatterns'];
const RES = ['status', 'headers', 'body', 'fixedDelayMilliseconds', 'fault'];
const FAULTS = ['CONNECTION_RESET_BY_PEER', 'EMPTY_RESPONSE', 'MALFORMED_RESPONSE_CHUNK'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isMatcher(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.entries(value);
  return (
    entries.length === 1 &&
    ['equalTo', 'contains', 'doesNotContain'].includes(entries[0]?.[0] ?? '') &&
    typeof entries[0]?.[1] === 'string'
  );
}

/** Problems of one mapping against the public WireMock 3 JSON mapping schema subset. */
export function shapeProblems(input: unknown): string[] {
  const m = input as Record<string, unknown>;
  const req = (m['request'] ?? {}) as Record<string, unknown>;
  const res = (m['response'] ?? {}) as Record<string, unknown>;
  const name = String(m['name']);
  const out: string[] = [];
  const extra = (o: Record<string, unknown>, keys: string[]) =>
    Object.keys(o).filter((k) => !keys.includes(k));
  out.push(
    ...[...extra(m, [...TOP, 'request', 'response']), ...extra(req, REQ), ...extra(res, RES)].map(
      (k) => `${name}: unknown key ${k}`,
    ),
  );
  if (typeof m['id'] !== 'string' || !UUID.test(m['id'])) out.push(`${name}: id is not a UUID`);
  if (typeof m['name'] !== 'string' || m['name'] === '') out.push('mapping without a name');
  if (!Number.isInteger(m['priority'])) out.push(`${name}: priority is not an integer`);
  if (!['GET', 'POST', 'ANY'].includes(String(req['method']))) out.push(`${name}: bad method`);
  if (['url', 'urlPath', 'urlPathPattern'].filter((k) => typeof req[k] === 'string').length !== 1) {
    out.push(`${name}: needs exactly one of url / urlPath / urlPathPattern`);
  }
  const headers = (req['headers'] ?? {}) as Record<string, unknown>;
  if (!Object.values(headers).every(isMatcher)) out.push(`${name}: bad header matcher`);
  const body = req['bodyPatterns'] ?? [];
  if (!Array.isArray(body) || !body.every(isMatcher)) out.push(`${name}: bad bodyPatterns`);
  if (res['fault'] !== undefined) {
    if (!FAULTS.includes(String(res['fault']))) out.push(`${name}: unknown fault`);
  } else if (
    !Number.isInteger(res['status']) ||
    Number(res['status']) < 100 ||
    Number(res['status']) > 599
  ) {
    out.push(`${name}: status is not an HTTP status`);
  }
  const delay = res['fixedDelayMilliseconds'];
  if (delay !== undefined && (!Number.isInteger(delay) || Number(delay) < 0)) {
    out.push(`${name}: bad fixedDelayMilliseconds`);
  }
  if (res['body'] !== undefined && typeof res['body'] !== 'string')
    out.push(`${name}: body not a string`);
  const rh = (res['headers'] ?? {}) as Record<string, unknown>;
  if (!Object.values(rh).every((v) => typeof v === 'string'))
    out.push(`${name}: bad response header`);
  if (
    (m['newScenarioState'] !== undefined || m['requiredScenarioState'] !== undefined) &&
    typeof m['scenarioName'] !== 'string'
  ) {
    out.push(`${name}: scenario state without scenarioName`);
  }
  return out;
}

/** A first-turn OpenAI-compatible request body (no tool result yet). */
export function firstTurnBody(): string {
  return JSON.stringify({
    model: 'qwen-flash-2025-07-28',
    messages: [
      { role: 'system', content: '合成：你是找货助手。' },
      { role: 'user', content: '合成：找一款保温杯' },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
}

/** A second-turn body carrying the tool result of the first turn. */
export function secondTurnBody(): string {
  return JSON.stringify({
    model: 'qwen-flash-2025-07-28',
    messages: [
      { role: 'system', content: '合成：你是找货助手。' },
      { role: 'user', content: '合成：找一款保温杯' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'search_products', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: '{"cards":[]}', tool_call_id: 'call_x' },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
}

export function bailianProbe(body: string): Probe {
  return {
    method: 'POST',
    url: BAILIAN_PATH,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body,
  };
}

/** The probe B1-04c's replay client sends for a recording through base `<wiremock>/union/<p>`. */
export function unionProbe(input: UnionRecordingInput): Probe {
  const rec = input.recording as { request: { method: string; path: string; body?: string } };
  return {
    method: rec.request.method,
    url: `/union/${input.platform}${rec.request.path}`,
    headers: { 'X-Scenario': input.scenario },
    ...(rec.request.body === undefined ? {} : { body: rec.request.body }),
  };
}

export function isFault(m: LoadStubMapping): boolean {
  const s = m.response.status;
  return m.response.fault !== undefined || (s !== undefined && (s === 429 || s >= 500));
}
