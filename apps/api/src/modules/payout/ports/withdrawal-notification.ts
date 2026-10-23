// B2-05l (BR-WDR-10, BR-TEXT-09; D10-260): payout's read port for the notification module. When it
// consumes wallet.withdrawal_changed (payload stays {withdrawal_id, user_id, status}), notification
// reads the withdrawal's fields here to pick the WD_REJECTED sentence (NEGATIVE_BALANCE or not).
// One SELECT on withdrawals, same app only (another app or unknown id → null), on the caller's
// handle (transaction or connection). No payee name / account / cipher / HMAC / bank name, no
// decryption, no writes, no logging. Amounts are bigint fen as stored (formatting belongs to
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
  throw new Error('NotImplemented: createWithdrawalNotificationReader');
}
