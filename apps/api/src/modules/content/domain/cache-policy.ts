// Refresh rule of the content read caches. 规划/02 §10 lets ordinary parameters take effect by
// their cache refresh rule without fixing the period; the period below is the local choice of
// task F1-02b (recorded in the header of test/spec/content/read/kit.ts).

/** How long an entry is served after the load that produced it started. */
export const CONTENT_CACHE_TTL_MS = 60_000;

/**
 * Whether an entry whose load started at `loadedAtMs` may still be served at `nowMs`: only while
 * its age is in [0, ttlMs). It has expired at age >= ttlMs. A clock that is now before the load
 * also counts as expired, so a backwards step can never stretch an entry's lifetime.
 */
export function isFresh(loadedAtMs: number, nowMs: number, ttlMs: number): boolean {
  const ageMs = nowMs - loadedAtMs;
  return ageMs >= 0 && ageMs < ttlMs;
}
