// Read-only SQL for the per-order nets port (BR-FUND-08, BR-FUND-19 ④⑤). One SELECT on the
// handle it is given: no transaction, savepoint, lock or write; no clock or date cutoff.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/**
 * One entry of a voucher of the order, with the voucher's structured columns and the owner of
 * the entry's account. A voucher without entries comes back once with the entry columns NULL.
 */
export interface OrderEntryRow {
  readonly voucher_id: string;
  readonly voucher_kind: string | null;
  readonly beneficiary_user_id: string | null;
  readonly role: string | null;
  readonly amount_fen: bigint | null;
  readonly ledger_type: string | null;
  readonly sub_type: string | null;
  readonly owner_type: string | null;
  readonly owner_id: string | null;
  readonly subject: string | null;
}

/**
 * Every voucher of (app_id, order_key) — exact equality on the structured order_key column, never
 * uniq_key, biz_id or memo — with each of its entries (all sub-accounts, all accounting dates) and
 * the entry's account of the same app_id. Each entry appears exactly once (entries join their own
 * voucher and their own account by primary key), so sums over the rows never double count.
 */
export async function readOrderEntries(
  db: Kysely<DB>,
  appId: string,
  orderKey: string,
): Promise<OrderEntryRow[]> {
  return db
    .selectFrom('ledger_vouchers as v')
    .leftJoin('ledger_entries as e', (join) =>
      join.onRef('e.app_id', '=', 'v.app_id').onRef('e.voucher_id', '=', 'v.id'),
    )
    .leftJoin('ledger_accounts as a', (join) =>
      join.onRef('a.app_id', '=', 'e.app_id').onRef('a.id', '=', 'e.account_id'),
    )
    .select([
      'v.id as voucher_id',
      'v.voucher_kind',
      'v.beneficiary_user_id',
      'v.role',
      'e.amount_fen',
      'e.ledger_type',
      'e.sub_type',
      'a.owner_type',
      'a.owner_id',
      'a.subject',
    ])
    .where('v.app_id', '=', appId)
    .where('v.order_key', '=', orderKey)
    .orderBy('v.id')
    .orderBy('e.id')
    .execute();
}
