// Trace id of a request (规划/04 §5: `X-Trace-Id` request header, `trace_id` in the envelope).
import { randomUUID } from 'node:crypto';

const TRACE_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Adopts exactly 32 hexadecimal digits or a UUID in 8-4-4-4-12 form, preserving case.
 * Everything else gets a fresh random v4 UUID, without converting or trimming the input.
 */
export function resolveTraceId(incoming: unknown): string {
  // Check length too: JavaScript's `$` can match before a final line terminator.
  return typeof incoming === 'string' &&
    (incoming.length === 32 || incoming.length === 36) &&
    TRACE_ID.test(incoming)
    ? incoming
    : randomUUID();
}
