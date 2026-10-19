// SQL of the daily check (BR-FUND-19): the daily_balances snapshot write and the read-only
// execution of one invariant file. Tables are schema-qualified (app.*), as in the invariant SQL.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface DailyBalancesWrite {
  /** Validated YYYY-MM-DD accounting date D. */
  readonly accountingDate: string;
  /** Limits the written snapshots to one app; undefined writes every app. */
  readonly appId: string | undefined;
  /** computed_at of every written row (the injected Clock). */
  readonly computedAt: Date;
}

/**
 * One INSERT … SELECT … ON CONFLICT DO UPDATE (a single statement: one consistent read of the
 * entries, and a re-run of the same day overwrites instead of accumulating).
 *
 * Entry convention (decision 20): amounts are debit-positive / credit-negative; a voucher's
 * accounting_date is the entry's accounting date.
 * - Rows written: every account × sub-account with an entry dated ≤ D, or with a daily_balances
 *   row dated ≤ D (a stale row of D itself is recomputed, never left behind), within appId.
 * - opening = closing of the D−1 row when it exists, otherwise Σ amount_fen dated < D.
 * - debit = Σ positive amounts dated D; credit = Σ |negative amounts| dated D (both ≥ 0).
 * - closing = opening + debit − credit.
 * sum(bigint) is numeric, so every intermediate is exact; the final ::bigint cast fails loudly
 * on int64 overflow instead of wrapping.
 */
export async function writeDailyBalances(db: Kysely<DB>, input: DailyBalancesWrite): Promise<void> {
  const appId = input.appId ?? null;
  await sql`
    WITH params AS (
      SELECT ${input.accountingDate}::date AS check_date, ${appId}::text AS app_id
    ),
    movements AS (
      SELECT
        e.app_id,
        e.account_id,
        e.sub_account,
        COALESCE(sum(e.amount_fen) FILTER (WHERE v.accounting_date < p.check_date), 0)
          AS prior_fen,
        COALESCE(
          sum(e.amount_fen) FILTER (WHERE v.accounting_date = p.check_date AND e.amount_fen > 0),
          0
        ) AS debit_fen,
        COALESCE(
          sum(0 - e.amount_fen::numeric)
            FILTER (WHERE v.accounting_date = p.check_date AND e.amount_fen < 0),
          0
        ) AS credit_fen
      FROM app.ledger_entries e
      JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
      CROSS JOIN params p
      WHERE v.accounting_date <= p.check_date
        AND (p.app_id IS NULL OR e.app_id = p.app_id)
      GROUP BY e.app_id, e.account_id, e.sub_account
    ),
    targets AS (
      SELECT m.app_id, m.account_id, m.sub_account FROM movements m
      UNION
      SELECT d.app_id, d.account_id, d.sub_account
      FROM app.daily_balances d
      CROSS JOIN params p
      WHERE d.accounting_date <= p.check_date
        AND (p.app_id IS NULL OR d.app_id = p.app_id)
    ),
    computed AS (
      SELECT
        t.app_id,
        t.account_id,
        t.sub_account,
        p.check_date AS accounting_date,
        CASE
          WHEN prev.app_id IS NOT NULL THEN prev.closing_fen::numeric
          ELSE COALESCE(m.prior_fen, 0)
        END AS opening_fen,
        COALESCE(m.debit_fen, 0) AS debit_fen,
        COALESCE(m.credit_fen, 0) AS credit_fen
      FROM targets t
      CROSS JOIN params p
      LEFT JOIN movements m
        ON m.app_id = t.app_id AND m.account_id = t.account_id AND m.sub_account = t.sub_account
      LEFT JOIN app.daily_balances prev
        ON prev.app_id = t.app_id
        AND prev.account_id = t.account_id
        AND prev.sub_account = t.sub_account
        AND prev.accounting_date = p.check_date - 1
    )
    INSERT INTO app.daily_balances (
      app_id, account_id, sub_account, accounting_date,
      opening_fen, debit_fen, credit_fen, closing_fen, computed_at
    )
    SELECT
      c.app_id,
      c.account_id,
      c.sub_account,
      c.accounting_date,
      c.opening_fen::bigint,
      c.debit_fen::bigint,
      c.credit_fen::bigint,
      (c.opening_fen + c.debit_fen - c.credit_fen)::bigint,
      ${input.computedAt}::timestamptz
    FROM computed c
    ON CONFLICT (app_id, account_id, sub_account, accounting_date) DO UPDATE SET
      opening_fen = EXCLUDED.opening_fen,
      debit_fen = EXCLUDED.debit_fen,
      credit_fen = EXCLUDED.credit_fen,
      closing_fen = EXCLUDED.closing_fen,
      computed_at = EXCLUDED.computed_at
  `.execute(db);
}

/**
 * Runs one trusted invariant query in its own READ ONLY, REPEATABLE READ transaction, after
 * setting couli.check_date transaction-locally (set_config(…, true) is SET LOCAL with a bound
 * parameter). Commit or rollback ends both the setting and the read-only mode, so nothing leaks
 * into the pooled session. Errors propagate unchanged (the transaction is rolled back first).
 */
export async function runInvariantQuery(
  db: Kysely<DB>,
  query: string,
  accountingDate: string,
): Promise<unknown> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      await sql`SELECT set_config('couli.check_date', ${accountingDate}, true)`.execute(trx);
      const result = await sql.raw<Record<string, unknown>>(query).execute(trx);
      return result.rows as unknown;
    });
}
