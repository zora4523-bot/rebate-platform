// 实名更正后的收款账号失效 (规划/08 BR-WDR-02 细则「实名更正后的失效与重绑」; 04 §3.2
// payout_account_changes.limit_exempt_reason; task B2-05j, used by admin B1-27g).
//
// createPayoutAccountInvalidation().invalidate — inside the caller's transaction, which already
// holds the users row lock of the subject (B1-27g's realname correction): every current
// payout_accounts row of the user is set is_current=false (row_version CAS, updated_at = now) and
// one payout_account_changes row is appended per retired row (old_* from that row,
// new_payout_method = the old method, new_hmac = '' — no new account, operator as given,
// changed_at = now, limit_exempt_reason = 'realname_correction'). No current row → nothing
// written, { retired: 0 }. No audit row and no event here (B1-27g writes its own).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface PayoutAccountInvalidationCommand {
  readonly appId: string;
  readonly userId: string;
  /** Recorded as is on the change rows, e.g. 'admin:<id>'. */
  readonly operator: string;
  readonly now: Date;
}

export interface PayoutAccountInvalidationResult {
  /** Current rows set is_current=false (one exempt change row each). */
  readonly retired: number;
}

export interface PayoutAccountInvalidation {
  invalidate(
    trx: Transaction<DB>,
    command: PayoutAccountInvalidationCommand,
  ): Promise<PayoutAccountInvalidationResult>;
}

export function createPayoutAccountInvalidation(): PayoutAccountInvalidation {
  throw new Error('NotImplemented: createPayoutAccountInvalidation');
}
