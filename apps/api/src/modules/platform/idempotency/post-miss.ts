import type { Idempotency, IdempotentRequest } from './index.ts';

export type IdempotencyPostMissCheck = (request: IdempotentRequest) => Promise<void>;

/**
 * Register on this instance, for both execute modes. Invoke only after an absent-key lookup,
 * before the first idempotency write and before the handler. Await checks in registration order;
 * rethrow rejection unchanged. Replay, processing/conflicting/abandoned keys do not run checks.
 * Request-specific HTTP context belongs to the caller; registration must not leak across
 * instances or simultaneous requests. Risk registers stage ④a here during app assembly.
 */
export function registerIdempotencyPostMissCheck(
  idempotency: Idempotency,
  check: IdempotencyPostMissCheck,
): void {
  void idempotency;
  void check;
  throw new Error('NotImplemented: registerIdempotencyPostMissCheck');
}
