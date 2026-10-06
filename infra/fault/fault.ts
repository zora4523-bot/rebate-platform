// Shared fault-injection tool (QA-05a; 规划/11 §1.1 exception: the shared injection tool belongs
// to QA-05 only, B1-14 and QA-06 import it). It drives a local WireMock container
// (infra/fault/compose.yaml) through its admin API and never talks to a real upstream
// (09 README §0.2 hard rule 5; 02 §12.7). Node built-ins only; the entry point is
// infra/fault/cli.ts (`node infra/fault/cli.ts <command>`), documented in infra/fault/README.md.
//
// Targets: `bailian` answers in the public OpenAI-compatible format with synthetic bodies;
// `union.<platform>` only gets fault stubs — a success body there needs a real recording
// (AGENTS.md hard rule 7).
// TODO(规划/11 §4.5): union replay mode with recorded success bodies — blocked on B1-04c.

/** Fault scenarios of 规划/05 QA-05 (delay, timeout, 429, 5xx, connection reset) plus `normal`. */
export type FaultKind = 'delay' | 'timeout' | 'rate_limited' | 'server_error' | 'connection_reset';
export type Scenario = 'normal' | FaultKind;

/** Fake upstreams; names follow the governor dependency names (`union.taobao`, …). */
export type FaultTarget = 'bailian' | 'union.taobao' | 'union.jd' | 'union.pdd';

/** WireMock JSON stub format (public WireMock 3 mapping schema, the subset this tool uses). */
export interface StringMatcher {
  equalTo: string;
}

export interface StubRequest {
  method: string;
  urlPathPattern: string;
  headers?: Record<string, StringMatcher>;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  body?: string;
  fixedDelayMilliseconds?: number;
  fault?: 'CONNECTION_RESET_BY_PEER' | 'EMPTY_RESPONSE' | 'MALFORMED_RESPONSE_CHUNK';
}

export interface StubMapping {
  id?: string;
  name: string;
  priority: number;
  scenarioName?: string;
  requiredScenarioState?: string;
  request: StubRequest;
  response: StubResponse;
}

export interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'error';
  signal?: AbortSignal;
}

export interface FetchResult {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResult>;

export interface CliDeps {
  fetch: FetchLike;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** All targets, in a stable order. */
export function faultTargets(): readonly FaultTarget[] {
  return ['bailian', 'union.taobao', 'union.jd', 'union.pdd'];
}

/** The scenarios a target supports (union targets have no `normal` and no `delay`). */
export function scenariosOf(target: FaultTarget): readonly Scenario[] {
  if (!faultTargets().includes(target)) throw new Error('未知故障目标');
  const faults: Scenario[] = ['timeout', 'rate_limited', 'server_error', 'connection_reset'];
  return target === 'bailian' ? ['normal', 'delay', ...faults] : faults;
}

function scenarioName(target: FaultTarget): string {
  return `couli-fault.${target}`;
}

function responseFor(scenario: Scenario): StubResponse {
  switch (scenario) {
    case 'normal':
    case 'delay':
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...(scenario === 'delay' ? { fixedDelayMilliseconds: 1000 } : {}),
        jsonBody: {
          id: 'chatcmpl-couli-synthetic',
          object: 'chat.completion',
          created: 0,
          model: 'couli-synthetic',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '本地故障注入合成应答。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      };
    case 'timeout':
      return { status: 504, fixedDelayMilliseconds: 15000 };
    case 'rate_limited':
      return { status: 429, headers: { 'Retry-After': '1' } };
    case 'server_error':
      return { status: 503 };
    case 'connection_reset':
      return { fault: 'CONNECTION_RESET_BY_PEER' };
  }
}

/** Every WireMock stub of one target. */
export function buildMappings(target: FaultTarget): StubMapping[] {
  const scenarios = scenariosOf(target);
  const request: StubRequest = {
    method: target === 'bailian' ? 'POST' : 'ANY',
    urlPathPattern:
      target === 'bailian'
        ? '/bailian/compatible-mode/v1/chat/completions'
        : `/union/${target.slice('union.'.length)}/.*`,
  };
  const mappings = scenarios.flatMap((scenario): StubMapping[] => [
    {
      name: `${target}.${scenario}.header`,
      priority: 1,
      request: { ...request, headers: { 'X-Scenario': { equalTo: scenario } } },
      response: responseFor(scenario),
    },
    {
      name: `${target}.${scenario}.state`,
      priority: 10,
      scenarioName: scenarioName(target),
      requiredScenarioState: scenario,
      request: { ...request },
      response: responseFor(scenario),
    },
  ]);
  if (target === 'bailian') {
    mappings.push({
      name: `${target}.normal.initial`,
      priority: 10,
      scenarioName: scenarioName(target),
      requiredScenarioState: 'Started',
      request: { ...request },
      response: responseFor('normal'),
    });
  }
  // Stable UUIDs let WireMock overwrite the same stubs on repeated imports. Slots are
  // deliberately reserved per target; never reorder targets/scenarios when adding stubs.
  return mappings.map((mapping, index) => ({
    ...mapping,
    id: `c011fa17-0000-4000-8000-${String(faultTargets().indexOf(target) * 100 + index).padStart(12, '0')}`,
  }));
}

/**
 * The WireMock admin base URL: `FAULT_WIREMOCK_URL`, or the port compose.yaml publishes on
 * 127.0.0.1. Only loopback and this compose project's `wiremock` service are allowed.
 */
export function resolveAdminUrl(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env['FAULT_WIREMOCK_URL'] ?? 'http://127.0.0.1:18089';
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]', 'wiremock'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('FAULT_WIREMOCK_URL 只允许本地 WireMock 的 HTTP 地址，不带凭据、路径或查询');
  }
  return url.origin;
}

/**
 * `load [target…]`, `switch <target> <scenario>`. Exit codes: 0 done, 1 the admin API failed,
 * 2 usage error (nothing is sent).
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let url: string;
  let method: string;
  let body: string;
  try {
    const [command, target, scenario] = argv;
    const isTarget = (value: string | undefined): value is FaultTarget =>
      faultTargets().some((candidate) => candidate === value);
    const admin = resolveAdminUrl(deps.env);
    if (command === 'load' && argv.slice(1).every(isTarget)) {
      const targets = argv.length === 1 ? faultTargets() : (argv.slice(1) as FaultTarget[]);
      url = `${admin}/__admin/mappings/import`;
      method = 'POST';
      body = JSON.stringify({
        mappings: [...new Set(targets)].flatMap(buildMappings),
        importOptions: { duplicatePolicy: 'OVERWRITE', deleteAllNotInImport: false },
      });
    } else if (
      command === 'switch' &&
      argv.length === 3 &&
      isTarget(target) &&
      scenariosOf(target).some((candidate) => candidate === scenario)
    ) {
      url = `${admin}/__admin/scenarios/${encodeURIComponent(scenarioName(target))}/state`;
      method = 'PUT';
      body = JSON.stringify({ state: scenario });
    } else {
      throw new Error('用法：load [target…] 或 switch <target> <scenario>；目标或场景不合法');
    }
  } catch {
    deps.stderr(
      '参数错误：使用 load [target…] 或 switch <target> <scenario>，管理地址必须为本地 WireMock HTTP 根地址。详见 infra/fault/README.md。',
    );
    return 2;
  }

  try {
    const result = await deps.fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
      // Never follow a redirect from a local listener to a real upstream. The timeout
      // bounds admin calls only; fault response delays belong to the client under test.
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (result.status < 200 || result.status >= 300) {
      deps.stderr(
        `WireMock 管理请求失败（HTTP ${String(result.status)}）；确认容器已启动，switch 前已 load。`,
      );
      return 1;
    }
    // Consume the response so repeated embedded calls can reuse their connections.
    await result.text();
    deps.stdout('WireMock 故障场景操作完成。');
    return 0;
  } catch {
    // Do not print remote response bodies or transport errors: neither is trusted.
    deps.stderr('WireMock 管理请求失败：连接失败、超时或重定向；请检查本地容器和管理地址。');
    return 1;
  }
}
