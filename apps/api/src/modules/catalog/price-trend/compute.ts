// B1-29a: the price trend of one product from its price_snapshot runs, a pure function.
import type { PriceTrend, PriceTrendRow } from './types.ts';

/**
 * Orchestrator rulings B.1-B.8 and B.10 (couli-runs/B1-29a/decision-orchestrator.md):
 *   window   the 30 natural days (+08:00) [today − 29, today], today = the +08:00 date of `now`;
 *   a day D  has a row's value iff the row's [firstObservedAt, lastObservedAt] meets D (runs
 *            crossing the window start or several days included; no carry-forward over gaps);
 *   per day  within one source the row whose latest instant inside D (min(last, end of D)) is
 *            greatest; across sources detail, then search, then quote; convert and watch ignored;
 *   points   one per day with a value, ascending; fewer distinct days than minDistinctDays →
 *            no_data (points [], start_date null, source_key 'price_trend.source.general');
 *   ok       start_date = first point's date; source_key from the coupon_fen of the row behind
 *            the last point (> 0 'price_trend.source', = 0 'price_trend.source.general').
 * minDistinctDays is a positive integer (the caller normalises it). Rows may come in any order.
 */
export function computePriceTrend(
  rows: readonly PriceTrendRow[],
  now: Date,
  minDistinctDays: number,
): PriceTrend {
  void rows;
  void now;
  void minDistinctDays;
  throw new Error('NotImplemented: computePriceTrend');
}
