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
// registerIdempotencyEntryObserver adds a synchronous observer called first on every entry to
// either execute mode (before validation, lookup or any hook): risk records with it that the
// idempotency module disposed of the request (ran the post-miss check, replayed, answered 40901 /
// 20901 / 20903 / 20001), so a route marked idempotent that never reached this instance fails
// closed instead of skipping stage ④a.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { idempotencyHooksOf, type Idempotency, type IdempotentRequest } from './index.ts';

export type IdempotencyPostMissCheck = (request: IdempotentRequest) => Promise<void>;
export type IdempotencyEntryObserver = (request: IdempotentRequest) => void;

function hooksOf(idempotency: Idempotency, name: string, hook: unknown) {
  const hooks = idempotencyHooksOf(idempotency);
  if (hooks === undefined) {
    throw new TypeError(`${name} needs an instance of createIdempotency`);
  }
  if (typeof hook !== 'function') throw new TypeError(`${name} needs a function`);
  return hooks;
}

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
  hooksOf(idempotency, 'registerIdempotencyPostMissCheck', check).postMiss.push(check);
}

/**
 * Register on this instance an observer called synchronously, in registration order, first on
 * every entry to execute / executeInTransaction. It sees every request the instance handles,
 * replays and refusals included; a throw propagates to the caller of execute.
 */
export function registerIdempotencyEntryObserver(
  idempotency: Idempotency,
  observer: IdempotencyEntryObserver,
): void {
  hooksOf(idempotency, 'registerIdempotencyEntryObserver', observer).entry.push(observer);
}
