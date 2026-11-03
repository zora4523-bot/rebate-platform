// B2-09j skeleton (BR-WDR-18「W < 1.5P 时告警财务」, D10-592): the worker's couli_payout_water_low
// gauge, one sample per app_id. Implementation follows the rule tests.
import type { Clock } from '../clock/index.ts';

/** One scrape's values. */
export interface WaterLowSnapshot {
  /**
   * app_id → 1 (W < 1.5P) or 0 (not low). An app_id without a conclusion (no W, or W older than
   * 2 hours) has no key at all: 0 means "checked, not low".
   */
  readonly waterLow: Readonly<Record<string, number>>;
}

export function cacheWaterLowCollector(
  collect: () => Promise<WaterLowSnapshot>,
  clock: Clock,
  ttlMs?: number,
): () => Promise<WaterLowSnapshot> {
  void collect;
  void clock;
  void ttlMs;
  throw new Error('NotImplemented: cacheWaterLowCollector');
}
