// SQL of the asset daily snapshot (BR-FUND-18, BR-FUND-20): ledger is the single writer of
// app.asset_snapshots and app.asset_snapshot_receivables. Every statement runs on the handle or
// transaction it is given. Entry convention (decision 20): amount_fen is debit-positive /
// credit-negative; an entry's accounting date is its voucher's accounting_date.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export interface LedgerBalanceTotals {
  readonly total_available_positive_fen: bigint;
  readonly total_negative_fen: bigint;
  readonly total_frozen_fen: bigint;
}

export interface PlatformReceivable {
  readonly platform: string;
  readonly union_receivable_fen: bigint;
}

export interface SnapshotRow {
  readonly id: string;
  readonly waiting_comparable: boolean;
}

export interface SnapshotInsert extends LedgerBalanceTotals {
  readonly id: string;
  readonly app_id: string;
  readonly snapshot_date: string;
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
  readonly waiting_comparable: boolean;
  readonly at: Date;
}

const RECEIVABLE_PREFIX = 'UNION_RECEIVABLE:';

/** The snapshot of (app, D), or undefined when it is not written yet. Never locks. */
export async function findSnapshot(
  db: Kysely<DB> | Transaction<DB>,
  appId: string,
  accountingDate: string,
): Promise<SnapshotRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('asset_snapshots')
    .select(['id', 'waiting_comparable'])
    .where('app_id', '=', appId)
    .where('snapshot_date', '=', sql<Date>`${accountingDate}::date`)
    .executeTakeFirst();
}

/**
 * USER_BALANCE accounts of the app, from entries dated ≤ D (not the account_balances cache, not
 * booked_at). Per account the available net is taken first, then split by sign: a user balance
 * is −Σ amount_fen, so a negative entry sum is a positive balance. Frozen is −Σ of the frozen
 * sub-account. sum(bigint) is numeric; the final ::bigint cast fails loudly on overflow.
 */
export async function sumUserBalances(
  trx: Transaction<DB>,
  appId: string,
  accountingDate: string,
): Promise<LedgerBalanceTotals> {
  const result = await sql<LedgerBalanceTotals>`
    WITH per_account AS (
      SELECT
        e.account_id,
        COALESCE(sum(e.amount_fen) FILTER (WHERE e.sub_account = 'available'), 0) AS available_net,
        COALESCE(sum(e.amount_fen) FILTER (WHERE e.sub_account = 'frozen'), 0) AS frozen_net
      FROM app.ledger_entries e
      JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
      JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
      WHERE e.app_id = ${appId}
        AND v.app_id = ${appId}
        AND v.accounting_date <= ${accountingDate}::date
        AND a.owner_type = 'user'
        AND a.subject = 'USER_BALANCE'
      GROUP BY e.account_id
    )
    SELECT
      COALESCE(sum(0 - available_net) FILTER (WHERE available_net < 0), 0)::bigint
        AS total_available_positive_fen,
      COALESCE(sum(available_net) FILTER (WHERE available_net > 0), 0)::bigint
        AS total_negative_fen,
      COALESCE(sum(0 - frozen_net), 0)::bigint AS total_frozen_fen
    FROM per_account
  `.execute(trx);
  const row = result.rows[0];
  if (row === undefined) throw new Error('asset snapshot balance query returned no row');
  return row;
}

/**
 * UNION_RECEIVABLE:{platform} accounts of the app (BR-FUND-20): Σ amount_fen (debit-positive) of
 * entries dated ≤ D, one row per platform with at least one such entry, in platform order. A
 * negative net (over-collected) is kept as is.
 */
export async function sumReceivables(
  trx: Transaction<DB>,
  appId: string,
  accountingDate: string,
): Promise<PlatformReceivable[]> {
  const result = await sql<PlatformReceivable>`
    SELECT
      substr(a.subject, ${RECEIVABLE_PREFIX.length + 1}) AS platform,
      sum(e.amount_fen)::bigint AS union_receivable_fen
    FROM app.ledger_entries e
    JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE e.app_id = ${appId}
      AND v.app_id = ${appId}
      AND v.accounting_date <= ${accountingDate}::date
      AND a.owner_type = 'platform'
      AND starts_with(a.subject, ${RECEIVABLE_PREFIX})
    GROUP BY a.subject
    ORDER BY platform
  `.execute(trx);
  return result.rows;
}

/**
 * INSERT … ON CONFLICT (app_id, snapshot_date) DO NOTHING: a concurrent open transaction holding
 * the same day is waited for, never raised as 23505. True when this call inserted the row.
 */
export async function insertSnapshotIfAbsent(
  trx: Transaction<DB>,
  row: SnapshotInsert,
): Promise<boolean> {
  const inserted = await trx
    .withSchema('app')
    .insertInto('asset_snapshots')
    .values({
      id: row.id,
      app_id: row.app_id,
      snapshot_date: row.snapshot_date,
      total_available_positive_fen: row.total_available_positive_fen,
      total_negative_fen: row.total_negative_fen,
      total_frozen_fen: row.total_frozen_fen,
      total_waiting_fen: row.total_waiting_fen,
      total_estimated_fen: row.total_estimated_fen,
      waiting_comparable: row.waiting_comparable,
      created_at: row.at,
      updated_at: row.at,
    })
    .onConflict((conflict) => conflict.columns(['app_id', 'snapshot_date']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

export async function insertReceivables(
  trx: Transaction<DB>,
  appId: string,
  snapshotId: string,
  rows: readonly PlatformReceivable[],
): Promise<void> {
  if (rows.length === 0) return;
  await trx
    .withSchema('app')
    .insertInto('asset_snapshot_receivables')
    .values(
      rows.map((row) => ({
        asset_snapshot_id: snapshotId,
        app_id: appId,
        platform: row.platform,
        union_receivable_fen: row.union_receivable_fen,
      })),
    )
    .execute();
}

/**
 * The write transaction's own row turned late after every write (BR-FUND-18): only ever true →
 * false, on the row this transaction inserted.
 */
export async function markNotComparable(
  trx: Transaction<DB>,
  appId: string,
  snapshotId: string,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('asset_snapshots')
    .set({ waiting_comparable: false, updated_at: at })
    .where('app_id', '=', appId)
    .where('id', '=', snapshotId)
    .execute();
}
