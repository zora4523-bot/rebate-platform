import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable } from 'kysely';

/** Only snapshot fields; current identity/payout-account data is never a projection input. */
export type WithdrawalRecordRow = Pick<
  Selectable<DB['withdrawals']>,
  | 'id'
  | 'status'
  | 'review_mode'
  | 'amount_fen'
  | 'fee_fen'
  | 'tax_fen'
  | 'net_fen'
  | 'payout_method'
  | 'payout_channel'
  | 'payee_account_cipher'
  | 'reject_reason_code'
  | 'fail_code'
  | 'created_at'
  | 'channel_order_id'
>;

/** In-memory decryption port; the cleartext must be masked before crossing the read boundary. */
export type DecryptWithdrawalAccount = (cipher: Buffer, method: string) => string;

export interface WithdrawalListQuery {
  readonly appId: string;
  readonly userId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WithdrawalPage {
  readonly items: Schema<'WithdrawalSummary'>[];
  readonly next_cursor: string | null;
}

export function projectWithdrawalSummary(
  row: WithdrawalRecordRow,
  decryptAccount: DecryptWithdrawalAccount,
): Schema<'WithdrawalSummary'> {
  void row;
  void decryptAccount;
  throw new Error('NotImplemented: projectWithdrawalSummary');
}

export function projectWithdrawalDetail(
  row: WithdrawalRecordRow,
  decryptAccount: DecryptWithdrawalAccount,
): Schema<'Withdrawal'> {
  void row;
  void decryptAccount;
  throw new Error('NotImplemented: projectWithdrawalDetail');
}

/** Process composition supplies decryption; public callers supply only the subject and paging.
 * Order: created_at DESC, id DESC. Cursor: base64url(created_at ISO + ':' + id).
 */
export function listWithdrawalsForUser(
  db: Kysely<DB>,
  query: WithdrawalListQuery,
): Promise<WithdrawalPage> {
  void db;
  void query;
  throw new Error('NotImplemented: listWithdrawalsForUser');
}
