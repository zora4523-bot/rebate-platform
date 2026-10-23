// B2-06c: the pure part of the watermark check of EXECUTE (规划/08 BR-WDR-18 ①②③, BR-WDR-12 ③).
// No I/O and no clock: the caller passes `now` and the amounts it read on its transaction.
//   forecastWindow  the last 7 complete natural days (+08:00) before the day of `now`:
//                   [today 00:00 +08:00 − 7 days, today 00:00 +08:00).
//   forecastFen     P = round_half_up(seven-day total / 7) × 3 (bigint fen).
//   judgeWatermark  in this order: no reading, or now − t_W > 2 hours → watermark_stale (exactly
//                   2 hours still passes); W < P → watermark_below_forecast;
//                   Σ batch net + Σ PAYING net + Σ net paid after t_W > W × usable_bp / 10000 →
//                   watermark_usable_exceeded (equality passes); otherwise ok.
// Amounts are bigint fen; sums go through @couli/money.

export type WatermarkRejectReason =
  | 'watermark_stale'
  | 'watermark_below_forecast'
  | 'watermark_usable_exceeded';

/** The latest payout_watermarks row of one channel: W and its measuring time t_W. */
export interface WatermarkReading {
  readonly availableFen: bigint;
  readonly measuredAt: Date;
}

export interface WatermarkCheckInput {
  readonly now: Date;
  /** null: no row for the channel (treated as stale). */
  readonly reading: WatermarkReading | null;
  /** P of BR-WDR-18. */
  readonly forecastFen: bigint;
  /** Σ net_fen of the withdrawals this EXECUTE would move to PAYING. */
  readonly batchNetFen: bigint;
  /** Σ net_fen of the withdrawals already in PAYING. */
  readonly payingNetFen: bigint;
  /** Σ net_fen of the withdrawals that reached PAID_API / PAID_MANUAL after t_W. */
  readonly paidSinceNetFen: bigint;
  /** payout.watermark_usable_bp (0..10000). */
  readonly usableBp: number;
}

export type WatermarkVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WatermarkRejectReason };

export interface ForecastWindow {
  /** Inclusive start: 00:00 +08:00 seven days before the day of `now`. */
  readonly from: Date;
  /** Exclusive end: 00:00 +08:00 of the day of `now`. */
  readonly to: Date;
}

export function forecastWindow(now: Date): ForecastWindow {
  void now;
  throw new Error('NotImplemented: forecastWindow');
}

export function forecastFen(sevenDayTotalFen: bigint): bigint {
  void sevenDayTotalFen;
  throw new Error('NotImplemented: forecastFen');
}

export function judgeWatermark(input: WatermarkCheckInput): WatermarkVerdict {
  void input;
  throw new Error('NotImplemented: judgeWatermark');
}
