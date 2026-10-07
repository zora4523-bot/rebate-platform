// Stage ④a registration point of the idempotent operations (规划/08 BR-ID-01 判定顺序 ④a, 细则
// 「最低支持版本的接口层拦截」: judged after the replay of ④, before ⑤; task B1-03c).
// createIdempotency (./index.ts) keeps one check list per instance it builds and, in both
// execute modes, awaits the list in registration order after the lookup found no record (or found
// a processing record whose lease expired, taken over like a missing one), before the first
// idempotency write and before the handler. A rejection propagates unchanged: nothing is written,
// the transaction rolls back and later checks and the handler do not run. Replays, processing
// (40901), conflicting (20901) and abandoned (20903) keys, and a key held by a concurrent request,
// never run the checks.
// Registration is per instance (./index.ts keys the lists by instance in a WeakMap);
// request-specific HTTP context is the registering module's business (risk carries it in its
// own AsyncLocalStorage), so nothing here is shared between simultaneous requests.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { postMissChecksOf, type Idempotency, type IdempotentRequest } from './index.ts';

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
  const checks = postMissChecksOf(idempotency);
  if (checks === undefined) {
    throw new TypeError('registerIdempotencyPostMissCheck needs an instance of createIdempotency');
  }
  if (typeof check !== 'function') throw new TypeError('a post-miss check must be a function');
  checks.push(check);
}
