// Shared helpers of the QA-05a fault-injection rule tests (规划/05 QA-05; 规划/02 §6.2 录制回放、
// 超时; 规划/02 §14). Nothing here listens, starts a container or goes to the network: WireMock is
// represented by its JSON stub format and a tiny matcher below, and the admin API by a recording
// fake fetch.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CliDeps,
  FaultTarget,
  FetchInit,
  Scenario,
  StubMapping,
  StubResponse,
} from '../../../infra/fault/fault.ts';

/** Repository file text, or '' when the file does not exist yet (an assertion then fails). */
export function repoText(path: string): string {
  const file = fileURLToPath(new URL(`../../../${path}`, import.meta.url));
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * The admin URL a local `load` / `switch` must use when FAULT_WIREMOCK_URL is unset, built
 * independently of the code under test: plain HTTP (WireMock's default listener in the
 * container) on 127.0.0.1 and the host port compose.yaml publishes for container port 8080.
 * Without that declaration the result is a sentinel no implementation can produce.
 */
export function expectedAdminUrl(): string {
  const port = /['"]?127\.0\.0\.1:(\d+):8080['"]?/.exec(repoText('infra/fault/compose.yaml'))?.[1];
  return port === undefined
    ? '(compose publishes no 127.0.0.1:<port>:8080)'
    : `http://127.0.0.1:${port}`;
}

export const ALL_TARGETS: readonly FaultTarget[] = [
  'bailian',
  'union.taobao',
  'union.jd',
  'union.pdd',
];
export const UNION_TARGETS: readonly FaultTarget[] = ['union.taobao', 'union.jd', 'union.pdd'];
export const FAULTS = ['delay', 'timeout', 'rate_limited', 'server_error', 'connection_reset'];
export const UNION_SCENARIOS = ['timeout', 'rate_limited', 'server_error', 'connection_reset'];

/** The scenarios each target must serve, written out here, never taken from the code under test. */
export const SCENARIOS_OF: Readonly<Record<FaultTarget, readonly Scenario[]>> = {
  bailian: ['normal', 'delay', 'timeout', 'rate_limited', 'server_error', 'connection_reset'],
  'union.taobao': ['timeout', 'rate_limited', 'server_error', 'connection_reset'],
  'union.jd': ['timeout', 'rate_limited', 'server_error', 'connection_reset'],
  'union.pdd': ['timeout', 'rate_limited', 'server_error', 'connection_reset'],
};

/**
 * Where each fake upstream lives inside WireMock (口径: the test-env base URL of the adapter is
 * `<wiremock>/bailian/compatible-mode/v1` or `<wiremock>/union/<platform>`).
 */
export const SAMPLE_PATH: Readonly<Record<FaultTarget, string>> = {
  bailian: '/bailian/compatible-mode/v1/chat/completions',
  'union.taobao': '/union/taobao/router/rest',
  'union.jd': '/union/jd/routerjson',
  'union.pdd': '/union/pdd/api/router',
};

export interface Probe {
  method: string;
  path: string;
  scenarioHeader?: string;
}

/**
 * The stub WireMock would answer with: method, full-match urlPathPattern, header matchers
 * (only `X-Scenario` is ever sent), scenario state (WireMock starts every scenario in
 * `Started`); the lowest priority number wins and a tie is ambiguous.
 */
export function answer(
  mappings: readonly StubMapping[],
  probe: Probe,
  states: ReadonlyMap<string, string> = new Map(),
): StubMapping | null | 'ambiguous' {
  const hits = mappings.filter((m) => {
    if (m.request.method !== 'ANY' && m.request.method !== probe.method) return false;
    if (!new RegExp(`^(?:${m.request.urlPathPattern})$`).test(probe.path)) return false;
    for (const [name, matcher] of Object.entries(m.request.headers ?? {})) {
      if (name.toLowerCase() !== 'x-scenario') return false;
      if (probe.scenarioHeader !== matcher.equalTo) return false;
    }
    if (m.scenarioName !== undefined) {
      const state = states.get(m.scenarioName) ?? 'Started';
      if (m.requiredScenarioState !== undefined && m.requiredScenarioState !== state) return false;
    }
    return true;
  });
  if (hits.length === 0) return null;
  const best = Math.min(...hits.map((m) => m.priority));
  const top = hits.filter((m) => m.priority === best);
  return top.length === 1 ? (top[0] ?? null) : 'ambiguous';
}

function header(response: StubResponse, name: string): string | undefined {
  const key = Object.keys(response.headers ?? {}).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : response.headers?.[key];
}

/**
 * Problems of a stub response for a scenario ([] = it injects what the scenario promises).
 * Timeouts are 规划/02 §6.2: online 3 s, offline 10 s.
 */
export function scenarioProblems(scenario: Scenario, response: StubResponse): string[] {
  const p: string[] = [];
  const delay = response.fixedDelayMilliseconds ?? 0;
  const okBody = (): void => {
    if (response.status !== 200) p.push(`status ${String(response.status)} is not 200`);
    const body = response.jsonBody as
      | { object?: unknown; model?: unknown; choices?: { message?: Record<string, unknown> }[] }
      | undefined;
    if (body?.object !== 'chat.completion') p.push('jsonBody.object is not chat.completion');
    if (typeof body?.model !== 'string') p.push('jsonBody.model is not a string');
    const message = body?.choices?.[0]?.message;
    if (message?.role !== 'assistant') p.push('choices[0].message.role is not assistant');
    if (typeof message?.content !== 'string' || message.content === '')
      p.push('choices[0].message.content is empty');
  };
  if (scenario !== 'connection_reset' && response.fault !== undefined) p.push('unexpected fault');
  switch (scenario) {
    case 'normal':
      okBody();
      if (delay !== 0) p.push(`normal must not be delayed (${String(delay)} ms)`);
      break;
    case 'delay':
      okBody();
      if (!(delay > 0 && delay < 3000)) p.push(`delay ${String(delay)} ms not in (0, 3000)`);
      break;
    case 'timeout':
      if (!(delay > 10000 && delay <= 60000))
        p.push(`delay ${String(delay)} ms not in (10000, 60000]`);
      break;
    case 'rate_limited':
      if (response.status !== 429) p.push(`status ${String(response.status)} is not 429`);
      if (!/^[1-9]\d*$/.test(header(response, 'retry-after') ?? ''))
        p.push('Retry-After is not a positive number of seconds');
      if (delay >= 3000) p.push('429 must answer within the online timeout');
      break;
    case 'server_error':
      if (!(response.status !== undefined && response.status >= 500 && response.status <= 599))
        p.push(`status ${String(response.status)} is not 5xx`);
      if (delay >= 3000) p.push('5xx must answer within the online timeout');
      break;
    case 'connection_reset':
      if (response.fault !== 'CONNECTION_RESET_BY_PEER')
        p.push('fault is not CONNECTION_RESET_BY_PEER');
      break;
  }
  return p;
}

export interface SentRequest {
  url: string;
  init: FetchInit;
}

/** CliDeps with a recording fake admin API that answers `status` to every call. */
export function fakeDeps(
  env: Record<string, string | undefined> = {},
  status = 200,
): { deps: CliDeps; sent: SentRequest[]; out: string[]; err: string[] } {
  const sent: SentRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env,
    fetch: (url, init) => {
      sent.push({ url, init });
      return Promise.resolve({ status, text: () => Promise.resolve('') });
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps, sent, out, err };
}

/** Scenario states set by `PUT <admin>/__admin/scenarios/<name>/state` calls. */
export function statesAfter(admin: string, sent: readonly SentRequest[]): Map<string, string> {
  const states = new Map<string, string>();
  const prefix = `${admin.replace(/\/+$/, '')}/__admin/scenarios/`;
  for (const { url, init } of sent) {
    if (init.method !== 'PUT' || !url.startsWith(prefix) || !url.endsWith('/state')) continue;
    const name = decodeURIComponent(url.slice(prefix.length, -'/state'.length));
    const state = (JSON.parse(init.body ?? '{}') as { state?: unknown }).state;
    if (typeof state === 'string') states.set(name, state);
  }
  return states;
}

/** The mappings carried by the `POST …/__admin/mappings/import` bodies the CLI sent. */
export function importedMappings(sent: readonly SentRequest[]): StubMapping[] {
  return sent.flatMap(({ init }) => {
    const body = JSON.parse(init.body ?? '{}') as { mappings?: StubMapping[] };
    return Array.isArray(body.mappings) ? body.mappings : [];
  });
}

/**
 * Problems of what a WireMock holding `mappings` would serve for `target` ([] = all served),
 * checked against SCENARIOS_OF: every scenario by X-Scenario header, every scenario by
 * scenario state (exactly one scenario name per state), and the initial `Started` state
 * (bailian normal, union nothing).
 */
export function serveProblems(mappings: readonly StubMapping[], target: FaultTarget): string[] {
  const p: string[] = [];
  const path = SAMPLE_PATH[target];
  const check = (label: string, scenario: Scenario, hit: ReturnType<typeof answer>): void => {
    if (hit === null || hit === 'ambiguous') {
      p.push(`${target} ${label}: ${String(hit)}`);
      return;
    }
    for (const problem of scenarioProblems(scenario, hit.response))
      p.push(`${target} ${label}: ${problem}`);
  };
  for (const scenario of SCENARIOS_OF[target]) {
    check(
      `X-Scenario ${scenario}`,
      scenario,
      answer(mappings, { method: 'POST', path, scenarioHeader: scenario }),
    );
    const names = [
      ...new Set(
        mappings
          .filter(
            (m) =>
              m.requiredScenarioState === scenario &&
              m.scenarioName !== undefined &&
              new RegExp(`^(?:${m.request.urlPathPattern})$`).test(path),
          )
          .map((m) => m.scenarioName ?? ''),
      ),
    ];
    if (names.length !== 1) {
      p.push(`${target} state ${scenario}: ${String(names.length)} scenario names`);
      continue;
    }
    check(
      `state ${scenario}`,
      scenario,
      answer(mappings, { method: 'POST', path }, new Map([[names[0] ?? '', scenario]])),
    );
  }
  const idle = answer(mappings, { method: 'POST', path });
  if (target === 'bailian') check('initial state', 'normal', idle);
  else if (idle !== null) p.push(`${target} initial state: a stub answers`);
  return p;
}
