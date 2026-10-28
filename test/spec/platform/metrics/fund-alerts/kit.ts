// B1-01zzp rule-test kit (规划/02 §13: 资金类夜间推送明列「自动到账日合计触顶」; 规划/08 BR-WDR-30 ⑨
// and 「告警：当日自动到账合计达到 platform_daily_max_fen 的 80% 时告警财务」). The two gauge names, the
// label, the +08:00 day of the clock and the fixture's expected values are written out here,
// independent of the code under test. The Prometheus text reader comes from B1-01zzh's kit and the
// user / recording-database helpers from B1-01zzi's kit (read only, not changed). The test database
// comes from the int tests (@couli/db/testing is allowed in *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { AutoPayoutDailySnapshot } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { insertUser } from '../../fund-metrics/kit.ts';
import { samples } from '../kit.ts';

/**
 * The injected clock's instant: 2031-04-06 01:30 at +08:00, still 2031-04-05 in UTC, so a UTC day
 * boundary and the +08:00 one differ. The database's own now() is years earlier on purpose.
 */
export const NOW = '2031-04-05T17:30:00.000Z';
/** 2031-04-06 00:00 at +08:00: the start of NOW's +08:00 day. */
export const DAY_START = '2031-04-05T16:00:00.000Z';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** An ISO instant shifted by milliseconds. */
export function shift(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

// ---- metric names ------------------------------------------------------------------------------

/** Σ amount_fen auto-paid today (BR-WDR-30 ⑨ 口径), per app_id. */
export const TOTAL_METRIC = 'couli_auto_payout_daily_total_fen';
/** withdraw.auto_payout.platform_daily_max_fen, per app_id. */
export const CAP_METRIC = 'couli_auto_payout_daily_cap_fen';
/** The one label both gauges carry, so the rule's division matches series one to one. */
export const LABEL = 'app_id';

export const AUTO_METRIC_NAMES: readonly string[] = [TOTAL_METRIC, CAP_METRIC];

/** The config key of the cap (BR-WDR-30 table ⑨). */
export const CAP_KEY = 'withdraw.auto_payout.platform_daily_max_fen';

/** Auto-payout metric names the text mentions (a sample, HELP or TYPE line). */
export function autoNamesIn(text: string): string[] {
  return AUTO_METRIC_NAMES.filter((name) =>
    new RegExp(`(^|[\\s{])${name}([\\s{]|$)`, 'm').test(text),
  );
}

/** One gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function autoGauge(text: string, name: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === name)) {
    expect(Object.keys(sample.labels), `${name} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${name}{${LABEL}="${appId}"} twice`).toBe(false);
    out[appId] = sample.value;
  }
  return out;
}

/** The auto-payout part of a rendered text, in snapshot form. */
export function autoFromText(text: string): AutoPayoutDailySnapshot {
  return { totalFen: autoGauge(text, TOTAL_METRIC), capFen: autoGauge(text, CAP_METRIC) };
}

/**
 * The snapshot compared on the app_ids `expected` names: those carry exactly the expected values;
 * any other app_id (e.g. one the seeds configured) may carry a cap but never a nonzero total.
 */
export function expectSnapshot(
  actual: AutoPayoutDailySnapshot,
  expected: AutoPayoutDailySnapshot,
): void {
  for (const [appId, value] of Object.entries(expected.totalFen)) {
    expect(actual.totalFen[appId], `totalFen[${appId}]`).toBe(value);
  }
  for (const [appId, value] of Object.entries(expected.capFen)) {
    expect(actual.capFen[appId], `capFen[${appId}]`).toBe(value);
  }
  const unexpected = Object.entries(actual.totalFen).filter(
    ([appId, value]) => value !== 0 && !Object.hasOwn(expected.totalFen, appId),
  );
  expect(unexpected, 'unexpected nonzero totals').toEqual([]);
  // Every configured app_id has a total, so total / cap has a series to divide.
  for (const appId of Object.keys(actual.capFen)) {
    expect(actual.totalFen[appId], `totalFen[${appId}] listed next to its cap`).toEqual(
      expect.any(Number),
    );
  }
  for (const value of [...Object.values(actual.totalFen), ...Object.values(actual.capFen)]) {
    expect(Number.isInteger(value), `${value} is whole fen`).toBe(true);
  }
}

// ---- database fixtures -------------------------------------------------------------------------

export const APP_A = 'fund_alerts_a';
export const APP_B = 'fund_alerts_b';
export const APP_C = 'fund_alerts_c';

export async function insertCap(db: Kysely<DB>, appId: string, fen: number): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${CAP_KEY}, ${JSON.stringify(fen)}::jsonb, 'seed')`.execute(db);
}

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED';

export interface WithdrawalRow {
  readonly appId: string;
  readonly userId: string;
  readonly status: WithdrawalStatus;
  readonly reviewMode: 'auto' | 'manual' | null;
  /** null only with status PENDING_REVIEW. */
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly amountFen: number;
  /** amount − fee = net (tax 0): the total sums amount_fen, never net_fen. */
  readonly feeFen: number;
}

export async function insertWithdrawal(db: Kysely<DB>, row: WithdrawalRow): Promise<void> {
  const id = randomUUID();
  const paid = row.status === 'PAID_API' || row.status === 'PAID_MANUAL';
  const manual = row.status === 'PAID_MANUAL';
  const paidAt = paid ? row.reviewedAt : null;
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
       review_mode, reviewer_id, reviewed_at, needs_manual, paid_at, manual_entry_by,
       manual_confirm_by, reject_reason_code, fail_code, created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${row.userId}, ${row.amountFen}, ${row.feeFen}, 0,
      ${row.amountFen - row.feeFen}, 'SERVICE_FEE', 'alipay', 'synthetic',
      ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, ${row.status},
      ${id.replaceAll('-', '')}, 'alipay', ${row.reviewMode},
      ${row.reviewMode === 'manual' ? randomUUID() : null}::uuid,
      ${row.reviewedAt}::timestamptz, false, ${paidAt}::timestamptz,
      ${manual ? randomUUID() : null}::uuid, ${manual ? randomUUID() : null}::uuid,
      ${row.status === 'REJECTED' ? 'RISK_SUSPECT' : null},
      ${row.status === 'FAILED' ? 'synthetic' : null},
      ${row.createdAt}::timestamptz, ${row.reviewedAt ?? row.createdAt}::timestamptz)`.execute(db);
}

/**
 * Comments give each row's contribution at NOW (+08:00 day [DAY_START, DAY_START + 1 day)) and on
 * the +08:00 day before it. Returns the expected snapshots for a clock at NOW, a clock 1 ms before
 * DAY_START (the day before) and a clock one day after NOW (nothing reviewed yet that day).
 */
export async function seedAutoPayout(db: Kysely<DB>): Promise<{
  atNow: AutoPayoutDailySnapshot;
  dayBefore: AutoPayoutDailySnapshot;
  dayAfter: AutoPayoutDailySnapshot;
}> {
  await insertCap(db, APP_A, 200_000);
  await insertCap(db, APP_B, 50_000);
  await insertCap(db, APP_C, 300_000);
  const a = await insertUser(db, APP_A);
  const b = await insertUser(db, APP_B);
  const w = (
    appId: string,
    userId: string,
    status: WithdrawalStatus,
    reviewMode: 'auto' | 'manual' | null,
    reviewedAt: string | null,
    amountFen: number,
    createdAt = shift(reviewedAt ?? NOW, -HOUR_MS),
  ) =>
    insertWithdrawal(db, {
      appId,
      userId,
      status,
      reviewMode,
      reviewedAt,
      createdAt,
      amountFen,
      feeFen: 100,
    });

  // APP_A today: 30 000 + 25 000 + 20 000 + 15 000 + 10 000 = 100 000 (amount_fen, fee included).
  await w(APP_A, a, 'PAID_API', 'auto', DAY_START, 30_000); // exactly 00:00 +08:00 counts
  await w(APP_A, a, 'PAYING', 'auto', shift(NOW, -HOUR_MS), 25_000);
  await w(APP_A, a, 'APPROVED', 'auto', NOW, 20_000); // reviewed exactly at NOW
  await w(APP_A, a, 'PAID_MANUAL', 'auto', shift(NOW, -1_000), 15_000);
  // Created on the day before, reviewed today: the day is reviewed_at's, not created_at's.
  const createdDayBefore = shift(DAY_START, -HOUR_MS);
  await w(APP_A, a, 'PAID_API', 'auto', shift(DAY_START, 60_000), 10_000, createdDayBefore);
  // APP_A today, never counted: rejected or failed auto, manual review, not reviewed yet.
  await w(APP_A, a, 'REJECTED', 'auto', shift(NOW, -2 * HOUR_MS), 90_001);
  await w(APP_A, a, 'FAILED', 'auto', shift(NOW, -2 * HOUR_MS), 90_002);
  await w(APP_A, a, 'PAID_API', 'manual', shift(NOW, -HOUR_MS), 90_003);
  await w(APP_A, a, 'APPROVED', 'manual', shift(NOW, -HOUR_MS), 90_004);
  await w(APP_A, a, 'PENDING_REVIEW', null, null, 90_005);
  // APP_A the day before: 1 ms before 00:00 +08:00 (the same UTC date as NOW) → 7 000; and a day
  // before that → never in these three days.
  await w(APP_A, a, 'PAID_API', 'auto', shift(DAY_START, -1), 7_000);
  await w(APP_A, a, 'PAID_API', 'auto', shift(DAY_START, -DAY_MS - 1), 90_006);
  // The day before, never counted either: a failed auto payout.
  await w(APP_A, a, 'FAILED', 'auto', shift(DAY_START, -HOUR_MS), 90_007);
  // APP_B today: exactly 80% of its cap (40 000 / 50 000); counted under APP_B, not APP_A.
  await w(APP_B, b, 'PAYING', 'auto', shift(NOW, -HOUR_MS), 40_000);
  // APP_C: a cap, nothing auto-paid → 0.

  const capFen = { [APP_A]: 200_000, [APP_B]: 50_000, [APP_C]: 300_000 };
  return {
    atNow: { totalFen: { [APP_A]: 100_000, [APP_B]: 40_000, [APP_C]: 0 }, capFen },
    dayBefore: { totalFen: { [APP_A]: 7_000, [APP_B]: 0, [APP_C]: 0 }, capFen },
    dayAfter: { totalFen: { [APP_A]: 0, [APP_B]: 0, [APP_C]: 0 }, capFen },
  };
}

export async function withdrawalSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (await sql`SELECT to_jsonb(w) AS row FROM app.withdrawals w ORDER BY id`.execute(db)).rows;
}

export async function configSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  return (
    await sql`SELECT to_jsonb(c) AS row FROM app.config_items c ORDER BY app_id, key`.execute(db)
  ).rows;
}
