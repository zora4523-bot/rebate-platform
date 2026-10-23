// B2-05l (BR-WDR-10, BR-TEXT-09; D10-260): payout's read port for the notification module. When it
// consumes wallet.withdrawal_changed (payload stays {withdrawal_id, user_id, status}), notification
// reads the withdrawal's fields here to pick the WD_REJECTED sentence (NEGATIVE_BALANCE or not).
// One SELECT on withdrawals, same app only (another app or unknown id → null), on the caller's
// handle (transaction or connection). No personal or payee columns are selected, nothing is
// decrypted, written or logged. Amounts are bigint fen as stored (formatting belongs to
// notification). Exported through ../index.ts, never through ../read.ts (AC-B2-05f#10).
import type { DB } from '@couli/db';
import type { WithdrawalState } from '@couli/domain';
import type { Kysely } from 'kysely';

export interface WithdrawalNotificationView {
  withdrawal_id: string;
  user_id: string;
  status: WithdrawalState;
  reject_reason_code: string | null;
  amount_fen: bigint;
  net_fen: bigint;
  fee_fen: bigint;
  tax_fen: bigint;
  fail_code: string | null;
  payout_channel: 'alipay' | 'bank_card' | 'wechat';
  created_at: Date;
  paid_at: Date | null;
}

export interface WithdrawalNotificationReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; withdrawalId: string },
  ): Promise<WithdrawalNotificationView | null>;
}

export function createWithdrawalNotificationReader(): WithdrawalNotificationReader {
  return {
    async read(handle, subject) {
      const row = await handle
        .withSchema('app')
        .selectFrom('withdrawals')
        .select([
          'id',
          'user_id',
          'status',
          'reject_reason_code',
          'amount_fen',
          'net_fen',
          'fee_fen',
          'tax_fen',
          'fail_code',
          'payout_channel',
          'created_at',
          'paid_at',
        ])
        .where('app_id', '=', subject.appId)
        .where('id', '=', subject.withdrawalId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        withdrawal_id: row.id,
        user_id: row.user_id,
        status: row.status as WithdrawalState,
        reject_reason_code: row.reject_reason_code,
        amount_fen: row.amount_fen,
        net_fen: row.net_fen,
        fee_fen: row.fee_fen,
        tax_fen: row.tax_fen,
        fail_code: row.fail_code,
        payout_channel: row.payout_channel as WithdrawalNotificationView['payout_channel'],
        created_at: row.created_at,
        paid_at: row.paid_at,
      };
    },
  };
}
