// The worker's auto-payout daily gauges (B1-01zzp; 规划/02 §13 资金类「自动到账日合计触顶」;
// BR-WDR-30 ⑨ and its 80% alert). Read-only SQL over app.withdrawals and app.config_items, per
// app_id; "now" is the injected Clock only (never the database's now()). Only the worker exports
// them; the rules in couli-fund.yaml divide the two. The cap is payout's reading of the config
// (B2-11c, D10-393 (c)): entry.ts injects it, platform imports no business module and keeps no
// default of its own, so an unconfigured or malformed cap alerts on the value B2-11c executes with.
// The total is the 口径 of B2-11c's consumer (payout/application/auto-payout.ts ⑨): review_mode
// auto, status ∉ {REJECTED, FAILED}, reviewed_at in the +08:00 day of now, Σ amount_fen, restated
// here rather than imported for the same reason.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { fenToJsonNumber, parseFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import { cacheCollector } from './cache.ts';

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

/** The cap's config key (BR-WDR-30 table ⑨). */
const CAP_KEY = 'withdraw.auto_payout.platform_daily_max_fen';

/** Withdrawals that never count toward ⑨ (as B2-11c's NOT_COUNTED). */
const NOT_COUNTED = ['REJECTED', 'FAILED'] as const;

/** Default freshness of a cached snapshot: 5 minutes (规划/02 §13 common granularity). */
const DEFAULT_TTL_MS = 300_000;

export async function collectAutoPayoutDaily(
  db: Kysely<DB>,
  clock: Clock,
  capFenOf: AutoPayoutCapFenOf,
): Promise<AutoPayoutDailySnapshot> {
  const day = chinaDayRange(accountingDate(clock.now()));
  const totals = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select((eb) => [
      'app_id',
      eb.fn.coalesce(eb.fn.sum<string>('amount_fen'), sql<string>`0`).as('total'),
    ])
    .where('review_mode', '=', 'auto')
    .where('status', 'not in', [...NOT_COUNTED])
    .where('reviewed_at', '>=', sql<Date>`${day.start}::timestamptz`)
    .where('reviewed_at', '<', sql<Date>`${day.end}::timestamptz`)
    .groupBy('app_id')
    .orderBy('app_id')
    .execute();
  const caps = await db
    .withSchema('app')
    .selectFrom('config_items')
    .select(['app_id', 'value', 'version'])
    .where('key', '=', CAP_KEY)
    .orderBy('app_id')
    .execute();

  // Each listed app_id's own snapshot: the cap row when it has one, empty otherwise, so capFenOf
  // (payout's reading) decides the value, default included.
  const rows = new Map<string, AutoPayoutCapSnapshot>();
  for (const row of caps) {
    rows.set(row.app_id, new Map([[CAP_KEY, { value: row.value, version: row.version }]]));
  }
  const totalFen: Record<string, number> = {};
  for (const appId of rows.keys()) totalFen[appId] = 0;
  for (const row of totals) {
    const total = parseFen(row.total);
    if (total !== 0n || rows.has(row.app_id)) totalFen[row.app_id] = fenToJsonNumber(total);
  }
  const capFen: Record<string, number> = {};
  for (const appId of Object.keys(totalFen)) {
    capFen[appId] = fenToJsonNumber(capFenOf(rows.get(appId) ?? new Map()));
  }
  return { totalFen, capFen };
}

/**
 * The worker's auto-payout collection cached like the fund one (cacheFundCollector, B1-01zzo):
 * within ttlMs (default 300 000) the last successful snapshot, never a rejected one. A snapshot
 * also ends with its +08:00 day, so a scrape after midnight never serves the previous day's total.
 */
export function cacheAutoPayoutCollector(
  collect: () => Promise<AutoPayoutDailySnapshot>,
  clock: Clock,
  ttlMs = DEFAULT_TTL_MS,
): () => Promise<AutoPayoutDailySnapshot> {
  return cacheCollector(collect, clock, ttlMs, accountingDate);
}
