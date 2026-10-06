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
//
// Skeleton only (QA-05a test stage): every function throws NotImplemented.

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
  throw new Error('NotImplemented: faultTargets');
}

/** The scenarios a target supports (union targets have no `normal` and no `delay`). */
export function scenariosOf(target: FaultTarget): readonly Scenario[] {
  void target;
  throw new Error('NotImplemented: scenariosOf');
}

/** Every WireMock stub of one target. */
export function buildMappings(target: FaultTarget): StubMapping[] {
  void target;
  throw new Error('NotImplemented: buildMappings');
}

/**
 * The WireMock admin base URL: `FAULT_WIREMOCK_URL`, or the port compose.yaml publishes on
 * 127.0.0.1. Throws when the host is not loopback or a dotless service name.
 */
export function resolveAdminUrl(env: Readonly<Record<string, string | undefined>>): string {
  void env;
  throw new Error('NotImplemented: resolveAdminUrl');
}

/**
 * `load [target…]`, `switch <target> <scenario>`. Exit codes: 0 done, 1 the admin API failed,
 * 2 usage error (nothing is sent).
 */
export function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  void argv;
  void deps;
  throw new Error('NotImplemented: runCli');
}
