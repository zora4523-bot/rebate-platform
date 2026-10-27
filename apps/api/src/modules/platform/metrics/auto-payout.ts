// The worker's auto-payout daily gauges (B1-01zzp; 规划/02 §13 资金类「自动到账日合计触顶」;
// BR-WDR-30 ⑨ and its 80% alert). Read-only SQL over app.withdrawals and app.config_items, per
// app_id; "now" is the injected Clock only (never the database's now()). Only the worker exports
// them; the rules in couli-fund.yaml divide the two.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';

/** One scrape's values, keyed by app_id. */
export interface AutoPayoutDailySnapshot {
  /**
   * Σ amount_fen of the withdrawals with review_mode auto and status ∉ {REJECTED, FAILED} whose
   * reviewed_at falls on the current +08:00 day of the injected clock (BR-WDR-30 ⑨). Every app_id
   * of capFen is listed, 0 when nothing counts.
   */
  readonly totalFen: Readonly<Record<string, number>>;
  /** withdraw.auto_payout.platform_daily_max_fen of every app_id that has it configured. */
  readonly capFen: Readonly<Record<string, number>>;
}

export function collectAutoPayoutDaily(
  db: Kysely<DB>,
  clock: Clock,
): Promise<AutoPayoutDailySnapshot> {
  void db;
  void clock;
  throw new Error('NotImplemented: collectAutoPayoutDaily');
}
