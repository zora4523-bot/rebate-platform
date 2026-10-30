// Reads of the daily-check execution step (B2-02p): the users a ledger difference involves, from
// the ledger's own tables only. Every statement runs on the transaction it is given; none locks.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

/** Owners (users.id) of the USER_BALANCE accounts among `accountIds` in the app. */
export async function userAccountOwners(
  trx: Transaction<DB>,
  appId: string,
  accountIds: readonly string[],
): Promise<readonly string[]> {
  if (accountIds.length === 0) return [];
  const rows = await trx
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select('owner_id')
    .where('app_id', '=', appId)
    .where('owner_type', '=', 'user')
    .where('subject', '=', 'USER_BALANCE')
    .where('id', 'in', [...accountIds])
    .execute();
  return rows.map((row) => row.owner_id);
}

/** Owners of the user accounts that entries of these vouchers (of the app) were posted to. */
export async function voucherUserOwners(
  trx: Transaction<DB>,
  appId: string,
  voucherIds: readonly string[],
): Promise<readonly string[]> {
  if (voucherIds.length === 0) return [];
  const rows = await trx
    .withSchema('app')
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
    .select('a.owner_id')
    .distinct()
    .where('e.app_id', '=', appId)
    .where('a.app_id', '=', appId)
    .where('a.owner_type', '=', 'user')
    .where('a.subject', '=', 'USER_BALANCE')
    .where('e.voucher_id', 'in', [...voucherIds])
    .execute();
  return rows.map((row) => row.owner_id);
}

/** Beneficiaries named on the vouchers of these sub-orders (of the app). */
export async function orderBeneficiaries(
  trx: Transaction<DB>,
  appId: string,
  orderKeys: readonly string[],
): Promise<readonly string[]> {
  if (orderKeys.length === 0) return [];
  const rows = await trx
    .withSchema('app')
    .selectFrom('ledger_vouchers')
    .select('beneficiary_user_id')
    .distinct()
    .where('app_id', '=', appId)
    .where('order_key', 'in', [...orderKeys])
    .where('beneficiary_user_id', 'is not', null)
    .execute();
  const users: string[] = [];
  for (const row of rows) if (row.beneficiary_user_id !== null) users.push(row.beneficiary_user_id);
  return users;
}
