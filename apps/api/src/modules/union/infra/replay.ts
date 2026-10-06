import type { Clock } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionEndpoint } from '../domain/types.ts';

/** Framework metadata, not an upstream platform response schema. */
export interface UnionRecordingProvenance {
  readonly source: 'probe' | 'doc-derived' | 'synthetic';
  readonly capabilityId: string;
  readonly probeRunId: string | null;
  readonly capturedAt: string;
  readonly originalSha256: string;
  readonly sanitizerVersion: string;
}

export interface UnionReplayRequest {
  readonly method: 'GET' | 'POST';
  /** Relative to the configured base URL, retaining its path prefix. */
  readonly path: string;
  readonly scenario: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface UnionTransportRequest {
  readonly platform: RegisteredPlatform;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface UnionTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type UnionTransport = (request: UnionTransportRequest) => Promise<UnionTransportResponse>;

/** Internal replay failures; these are not HTTP contract error codes. */
export type UnionReplayErrorCode =
  | 'invalid_provenance'
  | 'invalid_replay_request'
  | 'recording_missing'
  | 'invalid_recording'
  | 'recording_mismatch';

export interface UnionReplayClient {
  send(platform: RegisteredPlatform, request: UnionReplayRequest): Promise<UnionTransportResponse>;
}

export interface UnionReplayClientOptions {
  readonly endpoints: readonly UnionEndpoint[];
  readonly transport: UnionTransport;
}

export interface UnionLoadedRecording {
  readonly platform: RegisteredPlatform;
  readonly scenario: string;
  readonly directory: string;
  readonly provenance: UnionRecordingProvenance;
  readonly loadedAt: string;
}

export interface UnionReplayReport {
  readonly recordings: readonly UnionLoadedRecording[];
  /** Necessary source check only; probe-run log verification belongs to the external guard. */
  readonly acceptanceEligible: boolean;
}

export interface UnionFileReplay {
  readonly transport: UnionTransport;
  report(): UnionReplayReport;
}

export interface UnionFileReplayOptions {
  /** fixtures/union-recordings root; each <platform>/<scenario> holds both JSON files. */
  readonly directory: string;
  readonly clock: Clock;
}

/**
 * recording.json is a framework envelope: { request: { method, path, body? }, response:
 * { status, headers, body } }. The request path is the URL pathname plus query string.
 * provenance.json carries UnionRecordingProvenance; payload bodies remain opaque strings.
 * Synthetic examples use scenario synthetic-smoke and no upstream field names.
 */
export function createUnionFileReplay(options: UnionFileReplayOptions): UnionFileReplay {
  void options;
  throw new Error('NotImplemented: createUnionFileReplay');
}

// TODO(规划/11 §4.5): WireMock 接入 — blocked on infra 任务
export function createUnionReplayClient(options: UnionReplayClientOptions): UnionReplayClient {
  void options;
  throw new Error('NotImplemented: createUnionReplayClient');
}

/** Metadata validation does not certify that a probe was run by the owner. */
export function parseUnionRecordingProvenance(input: unknown): UnionRecordingProvenance {
  void input;
  throw new Error('NotImplemented: parseUnionRecordingProvenance');
}
