// The worker's fund collection cached for 5 minutes (B1-01zzo; 规划/02 §13 common 5m granularity):
// the beneficiary held count groups a whole table, so scrapes within the TTL reuse the last
// successful snapshot. A rejected collection is never cached. Time comes from the injected Clock.
import type { Clock } from '../clock/index.ts';
import type { FundMetricsSnapshot } from './fund.ts';

/**
 * Within ttlMs (default 300 000) of the last successful collection: that same snapshot. Otherwise
 * one call of `collect`, shared by concurrent callers; its rejection is passed on and not cached.
 */
export function cacheFundCollector(
  collect: () => Promise<FundMetricsSnapshot>,
  clock: Clock,
  ttlMs?: number,
): () => Promise<FundMetricsSnapshot> {
  void collect;
  void clock;
  void ttlMs;
  throw new Error('NotImplemented: cacheFundCollector');
}
