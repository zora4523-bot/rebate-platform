// Request id ↔ OpenTelemetry trace id (B1-31; 规划/02 §13). The request id stays what 02 §13 says
// (a well-formed X-Trace-Id kept as sent, otherwise a UUID); these functions only translate it to
// and from the 32 lowercase hex digits of an OTel trace id, so logs, the X-Trace-Id response header
// and spans name the same trace.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as OtelApi from '@opentelemetry/api';
import type { Context, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api';

/**
 * The OpenTelemetry API as the CommonJS build (its global registry lives under a Symbol.for key, so
 * every loader shares it). A static import would let a bundler-style resolver pick the package's
 * "module" build, whose extension-less relative imports Node refuses.
 */
export const otel: typeof OtelApi = createRequire(import.meta.url)(
  '@opentelemetry/api',
) as typeof OtelApi;
const { trace, TraceFlags } = otel;

const HEX32 = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_TRACE_ID = '0'.repeat(32);
export const TRACE_ID_HEADER = 'x-trace-id';
export const TRACEPARENT_HEADER = 'traceparent';

/**
 * A request id (32 hex digits, or a UUID in 8-4-4-4-12 form; either case) as an OTel trace id:
 * 32 lowercase hex digits. Anything else (other lengths or characters, a trailing line break,
 * non-strings) gives null; the input is never trimmed or repaired.
 */
export function traceIdFromRequestId(requestId: unknown): string | null {
  if (typeof requestId !== 'string') return null;
  if (requestId.length === 32 && HEX32.test(requestId)) return requestId.toLowerCase();
  if (requestId.length === 36 && UUID.test(requestId)) {
    return requestId.replaceAll('-', '').toLowerCase();
  }
  return null;
}

/**
 * An OTel trace id (exactly 32 hex digits, either case) as a request id: the same digits,
 * lowercase, in UUID 8-4-4-4-12 form. Anything else gives null.
 */
export function requestIdFromTraceId(traceId: unknown): string | null {
  if (typeof traceId !== 'string' || traceId.length !== 32 || !HEX32.test(traceId)) return null;
  const h = traceId.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic per trace id (the same rule as TraceIdRatioBasedSampler: the low 8 hex digits). */
function sampledByRatio(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const bound = Math.floor(ratio * 0xffffffff);
  return Number.parseInt(traceId.slice(-8), 16) < bound;
}

function headerValue(carrier: unknown, getter: TextMapGetter, name: string): string | undefined {
  const value = getter.get(carrier, name);
  return typeof value === 'string' ? value : undefined;
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
  const ratio = options.sampleRatio;
  return {
    extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
      const traceId = traceIdFromRequestId(headerValue(carrier, getter, TRACE_ID_HEADER));
      if (traceId === null || traceId === INVALID_TRACE_ID) return context;
      return trace.setSpanContext(context, {
        traceId,
        spanId: randomBytes(8).toString('hex'),
        traceFlags: sampledByRatio(traceId, ratio) ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: true,
      });
    },
    inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
      const spanContext = trace.getSpanContext(context);
      if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return;
      const flags = (spanContext.traceFlags & TraceFlags.SAMPLED) === 0 ? '00' : '01';
      setter.set(
        carrier,
        TRACEPARENT_HEADER,
        `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
      );
      const requestId = requestIdFromTraceId(spanContext.traceId);
      if (requestId !== null) setter.set(carrier, TRACE_ID_HEADER, requestId);
    },
    fields(): string[] {
      return [TRACEPARENT_HEADER, TRACE_ID_HEADER];
    },
  };
}
