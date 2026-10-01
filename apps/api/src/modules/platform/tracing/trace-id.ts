// Trace id of a request (规划/04 §5: `X-Trace-Id` request header, `trace_id` in the envelope).
import { randomUUID } from 'node:crypto';

const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns the incoming `x-trace-id` header when it is a single well-formed value, otherwise
 * a random UUID. Client-supplied text is never echoed unless it matches the strict pattern.
 */
export function resolveTraceId(incoming: unknown): string {
  return typeof incoming === 'string' && TRACE_ID.test(incoming) ? incoming : randomUUID();
}
