// Request id ↔ OpenTelemetry trace id (B1-31; 规划/02 §13). The request id stays what 02 §13 says
// (a well-formed X-Trace-Id kept as sent, otherwise a UUID); these functions only translate it to
// and from the 32 lowercase hex digits of an OTel trace id, so logs, the X-Trace-Id response header
// and spans name the same trace.
import type { TextMapPropagator } from '@opentelemetry/api';

/**
 * A request id (32 hex digits, or a UUID in 8-4-4-4-12 form; either case) as an OTel trace id:
 * 32 lowercase hex digits. Anything else (other lengths or characters, a trailing line break,
 * non-strings) gives null; the input is never trimmed or repaired.
 */
export function traceIdFromRequestId(requestId: unknown): string | null {
  void requestId;
  throw new Error('NotImplemented: traceIdFromRequestId');
}

/**
 * An OTel trace id (exactly 32 hex digits, either case) as a request id: the same digits,
 * lowercase, in UUID 8-4-4-4-12 form. Anything else gives null.
 */
export function requestIdFromTraceId(traceId: unknown): string | null {
  void traceId;
  throw new Error('NotImplemented: requestIdFromTraceId');
}

export interface TracePropagatorOptions {
  /** OTEL_TRACES_SAMPLER_ARG, 0..1: whether an adopted inbound trace is marked sampled. */
  readonly sampleRatio: number;
}

/**
 * The process's TextMapPropagator.
 * - extract: only `x-trace-id` is read. A well-formed value (see traceIdFromRequestId, and a valid
 *   OTel trace id, so not all zeros) becomes a remote parent: that trace id, a random span id,
 *   sampled according to `sampleRatio`. A missing or malformed value (and any inbound
 *   `traceparent`) adds nothing, so the SDK starts a new trace.
 * - inject: for a valid active span context, W3C `traceparent` plus `x-trace-id` (the trace id in
 *   UUID form); nothing otherwise.
 * - fields: includes `traceparent` and `x-trace-id`.
 */
export function createTracePropagator(options: TracePropagatorOptions): TextMapPropagator {
  void options;
  throw new Error('NotImplemented: createTracePropagator');
}
