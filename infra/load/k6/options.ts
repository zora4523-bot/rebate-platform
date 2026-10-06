// k6 load-test options for QA-06a (规划/05 QA-06: search, link convert, Agent SSE and order sync at
// 3 x peak; upstreams are the QA-05a WireMock in infra/fault, never a real union API — 09 README
// §0.2 hard rule 5). Pure module: no Node built-ins, so the k6 entry script.ts (run by the
// grafana/k6 container, k6 >= 1.0 runs TypeScript) and the rule tests both import it. Scenario
// parameters and thresholds live in config.json next to this file; peaks point at 01 §7.3, P95
// targets at 01 §7.1.

/** The four scenarios of 规划/05 QA-06; each is also the name of the exec function in script.ts. */
export type ScenarioName = 'search' | 'convert' | 'agent_sse' | 'sync';

/** Which local base URL a scenario hits (api. / stream. / admin. entries of 02 §3). */
export type ServiceName = 'api' | 'stream' | 'admin';

/** Arrival-rate scenarios count requests per second; VU scenarios count concurrent streams. */
export type ExecutorName = 'ramping-arrival-rate' | 'ramping-vus';

/** The k6 metric whose P95 is held to `p95_ms` (SSE: time to first byte = first event). */
export type LatencyMetric = 'http_req_duration' | 'http_req_waiting';

export interface ScenarioConfig {
  service: ServiceName;
  method: 'GET' | 'POST';
  /** Path relative to the service base URL, starting with a single '/'. */
  path: string;
  executor: ExecutorName;
  /** Peak load (positive integer): requests per second, or concurrent VUs for ramping-vus. */
  peak: number;
  /** k6 durations, e.g. '30s', '2m'. */
  ramp_up: string;
  hold: string;
  latency_metric: LatencyMetric;
  /** P95 threshold in milliseconds (positive integer). */
  p95_ms: number;
  /** Failed-request rate threshold, 0 < error_rate < 1. */
  error_rate: number;
}

export interface LoadConfig {
  /** Load factor over the peak; QA-06 fixes it at 3. */
  multiplier: number;
  base_urls: Partial<Record<ServiceName, string>>;
  scenarios: Partial<Record<ScenarioName, ScenarioConfig>>;
}

export interface K6Stage {
  duration: string;
  target: number;
}

export interface K6Scenario {
  executor: ExecutorName;
  exec: string;
  stages: K6Stage[];
  timeUnit?: string;
  startRate?: number;
  preAllocatedVUs?: number;
  maxVUs?: number;
  startVUs?: number;
}

export interface K6Options {
  scenarios: Record<string, K6Scenario>;
  thresholds: Record<string, string[]>;
}

/** Every rule violation of a config (empty array = usable); human-readable, one entry per problem. */
export function configProblems(config: LoadConfig): string[] {
  void config;
  throw new Error('NotImplemented: configProblems');
}

/** k6 `options` for a valid config; throws (with the problems) on an invalid one. */
export function buildOptions(config: LoadConfig): K6Options {
  void config;
  throw new Error('NotImplemented: buildOptions');
}

/**
 * Base URL per service: `LOAD_API_BASE_URL`, `LOAD_STREAM_BASE_URL`, `LOAD_ADMIN_BASE_URL`
 * override config.base_urls; any resulting URL outside loopback / the `wiremock` service throws.
 */
export function resolveBaseUrls(
  config: LoadConfig,
  env: Readonly<Record<string, string | undefined>>,
): Partial<Record<ServiceName, string>> {
  void config;
  void env;
  throw new Error('NotImplemented: resolveBaseUrls');
}
