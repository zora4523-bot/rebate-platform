// WireMock load-test stubs (QA-06b; 规划/05 QA-06「k6 峰值 3 倍……上游用 WireMock」; 09 README §0.2
// hard rule 5: load only ever hits local fakes, never a real union or model endpoint). QA-06a's k6
// scripts put load on the API; the API's adapters point at this local WireMock.
//
// Union stubs replay B1-04c recordings (fixtures/union-recordings/<platform>/<scenario>/
// {recording.json,provenance.json}) verbatim; without a recording there is no union success stub
// (AGENTS.md hard rule 7). The public repository only holds `source: synthetic` samples; real
// recordings stay in the private repository and are rendered on the owner's machine only.
// Bailian stubs answer in the public OpenAI-compatible streaming format (SSE, tool-call
// fragments, a usage chunk, `data: [DONE]`) with synthetic content only.
//
// The output of buildLoadImport is the body of WireMock's POST /__admin/mappings/import; the
// container is defined in compose.yaml and started only by a future drill script.

export type LoadPlatform = 'taobao' | 'jd' | 'pdd';

/** Kind of an injected fault slot. */
export type LoadFaultKind = 'server_error' | 'rate_limited' | 'connection_reset';

/** One B1-04c recording directory, both files parsed as JSON but otherwise untouched. */
export interface UnionRecordingInput {
  platform: LoadPlatform;
  scenario: string;
  recording: unknown;
  provenance: unknown;
}

export interface LoadToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LoadStubOptions {
  /** Fixed delay of every success response, integer milliseconds in [0, 60000]; default 0. */
  delayMs?: number;
  /** Share of requests per stub group answered with a fault, integer percent in [0, 100]; default 0. */
  faultPercent?: number;
  /** Fault used in fault slots; default `server_error`. */
  faultKind?: LoadFaultKind;
  /** Tool call the first Bailian turn streams; default `search_products`. */
  toolCall?: LoadToolCall;
}

/** WireMock 3 JSON mapping format, the subset these stubs use. */
export type LoadStringMatcher =
  { equalTo: string } | { contains: string } | { doesNotContain: string };

export interface LoadStubRequest {
  method: 'GET' | 'POST' | 'ANY';
  url?: string;
  urlPath?: string;
  urlPathPattern?: string;
  headers?: Record<string, LoadStringMatcher>;
  bodyPatterns?: LoadStringMatcher[];
}

export interface LoadStubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  fixedDelayMilliseconds?: number;
  fault?: 'CONNECTION_RESET_BY_PEER' | 'EMPTY_RESPONSE' | 'MALFORMED_RESPONSE_CHUNK';
}

export interface LoadStubMapping {
  id: string;
  name: string;
  priority: number;
  scenarioName?: string;
  requiredScenarioState?: string;
  newScenarioState?: string;
  request: LoadStubRequest;
  response: LoadStubResponse;
}

export interface LoadImport {
  mappings: LoadStubMapping[];
}

/** Reads every <root>/<platform>/<scenario>/ that holds both files; a missing root throws. */
export function readUnionRecordings(root: string): UnionRecordingInput[] {
  void root;
  throw new Error('NotImplemented: readUnionRecordings');
}

/**
 * Bailian streaming stubs plus one replay stub group per recording. Invalid options, provenance
 * or recording envelopes throw instead of producing a stub.
 */
export function buildLoadImport(
  recordings: readonly UnionRecordingInput[],
  options: LoadStubOptions,
): LoadImport {
  void recordings;
  void options;
  throw new Error('NotImplemented: buildLoadImport');
}
