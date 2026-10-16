// B1-17b: the run decision of price_snapshot (BR-WATCH-05 (2)), a pure function.
import type { PriceRunDecision, PriceRunObservation, PriceSnapshotRun } from './types.ts';

/**
 * Compare one observation with the latest row of its key (same app_id, product_key, source_kind):
 *   no latest row, or any of price_fen / coupon_fen / final_price_fen / in_stock differs
 *     → insert (unless out of order, below);
 *   all four equal and observedAt − latest.lastObservedAt ≥ touchMinIntervalMinutes
 *     → touch: lastObservedAt = observedAt, observationCount = latest.observationCount + 1;
 *   all four equal and the gap is shorter → none (neither column moves);
 *   observedAt earlier than latest.lastObservedAt (out of order) → none, whatever the values.
 * touchMinIntervalMinutes is a positive integer (the caller normalises it).
 */
export function decidePriceRun(
  latest: PriceSnapshotRun | null,
  observation: PriceRunObservation,
  touchMinIntervalMinutes: number,
): PriceRunDecision {
  void latest;
  void observation;
  void touchMinIntervalMinutes;
  throw new Error('NotImplemented: decidePriceRun');
}
