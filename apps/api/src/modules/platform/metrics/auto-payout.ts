// The worker's auto-payout daily gauges (B1-01zzp; 规划/02 §13 资金类「自动到账日合计触顶」;
// BR-WDR-30 ⑨ and its 80% alert). Read-only SQL over app.withdrawals and app.config_items, per
// app_id; "now" is the injected Clock only (never the database's now()). Only the worker exports
// them; the rules in couli-fund.yaml divide the two. The cap is payout's reading of the config
// (B2-11c, D10-393 (c)): entry.ts injects it, platform imports no business module and keeps no
// default of its own, so an unconfigured or malformed cap alerts on the value B2-11c executes with.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';

/** One app.config_items row as read: its value and business version. */
export interface AutoPayoutCapEntry {
  readonly value: unknown;
  readonly version: number;
}

/**
 * One app_id's config_items as read, keyed by config key:
 * withdraw.auto_payout.platform_daily_max_fen is present only when that app_id has the row.
 */
export type AutoPayoutCapSnapshot = ReadonlyMap<string, AutoPayoutCapEntry>;

/**
 * payout's platform_daily_max_fen of one app_id's snapshot (B2-11c's autoPayoutConfigOf: absent
 * or malformed → its 08 default), injected by entry.ts.
 */
export type AutoPayoutCapFenOf = (snapshot: AutoPayoutCapSnapshot) => bigint;

/** One scrape's values, keyed by app_id. */
export interface AutoPayoutDailySnapshot {
  /**
   * Σ amount_fen of the withdrawals with review_mode auto and status ∉ {REJECTED, FAILED} whose
   * reviewed_at falls on the current +08:00 day of the injected clock (BR-WDR-30 ⑨). Every app_id
   * of capFen is listed, 0 when nothing counts.
   */
  readonly totalFen: Readonly<Record<string, number>>;
  /**
   * capFenOf's value for every app_id that has the cap row or a nonzero total: configured or not,
   * the cap B2-11c's decision uses.
   */
  readonly capFen: Readonly<Record<string, number>>;
}

export function collectAutoPayoutDaily(
  db: Kysely<DB>,
  clock: Clock,
  capFenOf: AutoPayoutCapFenOf,
): Promise<AutoPayoutDailySnapshot> {
  void db;
  void clock;
  void capFenOf;
  throw new Error('NotImplemented: collectAutoPayoutDaily');
}
