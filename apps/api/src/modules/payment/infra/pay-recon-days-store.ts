// B2-15n: payment's record of reconciled bill days (app.pay_recon_days, db/migrations/
// 0096_pay-recon-days.sql; insert-only, payment is its only writer). One row per (app, channel,
// bill day) whose bill a bill.recon run reconciled to the end (application/pay-recon.ts); the seed
// of the daily chain reads them back (application/pay-recon-schedule.ts). Plain SQL that names the
// schema; bill days travel as 'YYYY-MM-DD' texts (to_char in SQL, never a JS Date of a date
// column). No logging, no clock: the instant comes in.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

/** One reconciled (app, channel, bill day). */
export interface ReconciledDay {
  readonly id: string;
  readonly appId: string;
  readonly payChannel: string;
  /** The bill's +08:00 accounting day, YYYY-MM-DD. */
  readonly billDate: string;
  readonly reconciledAt: Date;
}

/**
 * Records `day` as reconciled on the caller's transaction; a day recorded before stays as it was
 * (pay_recon_days_day_key, ON CONFLICT DO NOTHING: a concurrent insert of the same day is waited
 * for, never raised).
 */
export async function recordReconciledDay(trx: Transaction<DB>, day: ReconciledDay): Promise<void> {
  await sql`
    INSERT INTO app.pay_recon_days (id, app_id, pay_channel, bill_date, reconciled_at)
    VALUES (${day.id}::uuid, ${day.appId}, ${day.payChannel}, ${day.billDate}::date,
      ${day.reconciledAt}::timestamptz)
    ON CONFLICT ON CONSTRAINT pay_recon_days_day_key DO NOTHING`.execute(trx);
}

/**
 * Per app with any reconciled day: the earliest, over its channels, of each channel's last
 * reconciled bill day (YYYY-MM-DD). The chain resumes at the day after it.
 */
export async function lastReconciledDays(db: Kysely<DB>): Promise<Map<string, string>> {
  const result = await sql<{ app_id: string; bill_date: string }>`
    SELECT per_channel.app_id, to_char(min(per_channel.bill_date), 'YYYY-MM-DD') AS bill_date
    FROM (
      SELECT app_id, pay_channel, max(bill_date) AS bill_date
      FROM app.pay_recon_days
      GROUP BY app_id, pay_channel
    ) AS per_channel
    GROUP BY per_channel.app_id`.execute(db);
  return new Map(result.rows.map((row) => [row.app_id, row.bill_date]));
}
