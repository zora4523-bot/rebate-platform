// B1-29a: the price trend of one product from its price_snapshot runs, a pure function.
import type { PriceTrend, PriceTrendPoint, PriceTrendRow } from './types.ts';
import { DAY_MS, WINDOW_DAYS, dayLabel, dayNumber, windowStart } from './window.ts';

export function noPriceTrend(): PriceTrend {
  return {
    status: 'no_data',
    points: [],
    start_date: null,
    window_days: WINDOW_DAYS,
    source_key: 'price_trend.source.general',
  };
}

const SOURCE_PRIORITY = { detail: 0, search: 1, quote: 2 } as const;

interface DailyChoice {
  readonly row: PriceTrendRow;
  readonly priority: number;
  readonly observedAt: number;
}

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
  const nowMs = now.getTime();
  const firstDay = dayNumber(nowMs) - WINDOW_DAYS + 1;
  const fromMs = windowStart(now).getTime();
  const choices: (DailyChoice | undefined)[] = Array.from({ length: WINDOW_DAYS });

  for (const row of rows) {
    if (row.sourceKind === 'convert' || row.sourceKind === 'watch') continue;
    const priority = SOURCE_PRIORITY[row.sourceKind];
    const firstMs = row.firstObservedAt.getTime();
    const lastMs = Math.min(row.lastObservedAt.getTime(), nowMs);
    if (firstMs > lastMs || lastMs < fromMs) continue;
    const start = Math.max(0, dayNumber(firstMs) - firstDay);
    const end = Math.min(WINDOW_DAYS - 1, dayNumber(lastMs) - firstDay);

    // A run contributes only on days it actually intersects, never across a gap.
    for (let index = start; index <= end; index += 1) {
      const observedAt = Math.min(lastMs, fromMs + (index + 1) * DAY_MS - 1);
      const previous = choices[index];
      if (
        previous === undefined ||
        priority < previous.priority ||
        (priority === previous.priority &&
          (observedAt > previous.observedAt ||
            (observedAt === previous.observedAt &&
              firstMs > previous.row.firstObservedAt.getTime())))
      ) {
        choices[index] = { row, priority, observedAt };
      }
    }
  }

  const points: PriceTrendPoint[] = [];
  let lastCoupon = 0n;
  for (let index = 0; index < WINDOW_DAYS; index += 1) {
    const choice = choices[index];
    if (choice === undefined) continue;
    points.push({
      date: dayLabel(now, firstDay + index),
      final_price_fen: choice.row.finalPriceFen,
    });
    lastCoupon = choice.row.couponFen;
  }
  const first = points[0];
  if (first === undefined || points.length < minDistinctDays) return noPriceTrend();
  return {
    status: 'ok',
    points,
    start_date: first.date,
    window_days: WINDOW_DAYS,
    source_key: lastCoupon > 0n ? 'price_trend.source' : 'price_trend.source.general',
  };
}
