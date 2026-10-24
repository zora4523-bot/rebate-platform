// B2-04q: the beneficiary_credits rows the R5a execution reads and closes itself, all on the
// caller's transaction (BR-FUND-04 ⑫). settlement owns beneficiary_credits; the status column only
// moves through the generated beneficiary-credit transition(), applied here as a CAS on
// (status, row_version). The order_key advisory lock is taken by the caller before any read here.
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';

export type ObligationRow = Selectable<DB['beneficiary_credits']>;

/** One obligation of the given sub-order and app; undefined when it is not that order's. */
export async function readObligation(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
  beneficiaryCreditId: string,
): Promise<ObligationRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('beneficiary_credits')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('beneficiary_credit_id', '=', beneficiaryCreditId)
    .executeTakeFirst();
}

/** The (user, role) keys of every open obligation of the sub-order (BR-FUND-19 ⑤). */
export async function readOpenObligationKeys(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<readonly { readonly user_id: string; readonly role: string }[]> {
  return trx
    .withSchema('app')
    .selectFrom('beneficiary_credits')
    .select(['user_id', 'role'])
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'open')
    .execute();
}

export interface ObligationClose {
  readonly app_id: string;
  readonly beneficiary_credit_id: string;
  readonly from: string;
  readonly to: string;
  readonly row_version: number;
  readonly closed_by: string;
  readonly closed_ref: string;
  readonly closed_at: Date;
  readonly voucher_id: string | null;
}

/** Closes one obligation with a CAS on (status, row_version); returns whether one row matched. */
export async function casCloseObligation(
  trx: Transaction<DB>,
  cas: ObligationClose,
): Promise<boolean> {
  const result = await trx
    .withSchema('app')
    .updateTable('beneficiary_credits')
    .set({
      status: cas.to,
      closed_by: cas.closed_by,
      closed_ref: cas.closed_ref,
      closed_at: cas.closed_at,
      voucher_id: cas.voucher_id,
      row_version: cas.row_version + 1,
    })
    .where('app_id', '=', cas.app_id)
    .where('beneficiary_credit_id', '=', cas.beneficiary_credit_id)
    .where('status', '=', cas.from)
    .where('row_version', '=', cas.row_version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
