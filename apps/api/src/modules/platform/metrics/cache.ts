// The worker's fund collection cached for 5 minutes (B1-01zzo; 规划/02 §13 common 5m granularity):
// the beneficiary held count groups a whole table, so scrapes within the TTL reuse the last
// successful snapshot. A rejected collection is never cached. Time comes from the injected Clock.
import type { Clock } from '../clock/index.ts';
import type { FundMetricsSnapshot } from './fund.ts';

/** Default freshness of a successful fund snapshot: 5 minutes. */
const DEFAULT_TTL_MS = 300_000;

/**
 * Within ttlMs (default 300 000) of the last successful collection: that same snapshot. Otherwise
 * one call of `collect`, shared by concurrent callers; its rejection is passed on and not cached.
 * A snapshot's age counts from the instant its collection started, so it is never served as
 * fresher than the reads behind it. An expired snapshot is never served again, not even when the
 * next collection fails.
 */
export function cacheFundCollector(
  collect: () => Promise<FundMetricsSnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<FundMetricsSnapshot> {
  return cacheCollector(collect, clock, ttlMs);
}

/**
 * cacheFundCollector's cache for any snapshot. With `windowOf`, a snapshot is served only while
 * windowOf(now) equals its value at the instant the collection started (e.g. the +08:00 day).
 */
export function cacheCollector<T>(
  collect: () => Promise<T>,
  clock: Clock,
  ttlMs: number,
  windowOf: (now: Date) => string = () => '',
): () => Promise<T> {
  let cached: { readonly value: T; readonly at: number; readonly window: string } | undefined;
  let inFlight: Promise<T> | undefined;

  return () => {
    const instant = clock.now();
    const now = instant.getTime();
    const window = windowOf(instant);
    if (cached !== undefined && now - cached.at < ttlMs && cached.window === window) {
      return Promise.resolve(cached.value);
    }
    // Expired: drop it, so a failing collection cannot fall back to it.
    cached = undefined;
    if (inFlight !== undefined) return inFlight;

    // Called synchronously; a synchronous throw becomes this call's rejection.
    const started = (async () => collect())();
    const shared = started.then(
      (value) => {
        if (inFlight === shared) {
          inFlight = undefined;
          cached = { value, at: now, window };
        }
        return value;
      },
      (error: unknown) => {
        if (inFlight === shared) inFlight = undefined;
        throw error;
      },
    );
    inFlight = shared;
    return shared;
  };
}
