// B2-07e: W11 — a withdrawal returned by W9 (APPROVED, hold_reason payer_side_after_transfer) is
// settled as PAID_API on the channel's proof of success (规划/08 BR-WDR-08 W11, BR-WDR-09,
// BR-WDR-23 ③ 决-08 A; contracts/openapi.yaml writeOffAdminReconDiff). Here the proof is the bill
// line the R2 reconciliation stored with the difference; the caller (ledger's write-off of that
// difference, through the port app.module hands in) owns the transaction.
// proveChannelSuccess(trx, input), in order:
//   switch payout.proven_success_writeoff.enabled (content's config, default on) off → refused
//   writeoff_disabled; lock order BR-WDR-07: identity's users row → ledger.lockBalances; the row
//   reread under the lock: status not APPROVED → WithdrawalConflictError (20902 withdrawal);
//   hold_reason not payer_side_after_transfer → refused withdrawal_not_returned; not exactly one
//   kind=transfer attempt, or that one not result=fail → refused transfer_attempts_mismatch; the
//   bill line's out_biz_no not the withdrawal's → refused not_payer_side_case; the bill amount not
//   net_fen → refused amount_mismatch;
//   transitionWithdrawal('APPROVED', 'CHANNEL_SUCCESS_PROVEN') as one CAS (PAID_API, paid_at the
//   bill line's booked time else `now`, channel_order_id from the bill line, hold_reason / hold_at
//   cleared, executor_id the operator, executed_at, row_version + 1; 0 rows → 20902 withdrawal);
//   WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID` through ledger.post (operator admin:<id>);
//   the attempt-append job on queue payout-attempt-append on the same transaction (D10-428);
//   wallet.withdrawal_changed on the same transaction.
// A refusal writes nothing. Logs carry ids and codes only, never the payee.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { EventBus, JobQueue } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from './withdraw-apply.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The guard conditions of W11 a call may be refused on (contract data.reason). */
export type ProvenSuccessRefusal =
  | 'writeoff_disabled'
  | 'withdrawal_not_returned'
  | 'transfer_attempts_mismatch'
  | 'not_payer_side_case'
  | 'amount_mismatch';

/** The bill line stored with the difference, as the proof of the channel's success. */
export interface ProvenBillLine {
  /** YYYY-MM-DD, the +08:00 accounting day of the bill. */
  readonly billDate: string;
  /** The out_biz_no the line names (null when it names none). */
  readonly outBizNo: string | null;
  /** The channel's order id of the line (null when it has none). */
  readonly channelOrderId: string | null;
  /** 入账时间, ISO with an explicit offset (null when the stored line has none). */
  readonly bookedAt: string | null;
}

export interface ProveChannelSuccessInput {
  readonly appId: string;
  readonly withdrawalId: string;
  /** The difference the proof comes from (the attempt record's idempotency key with the withdrawal). */
  readonly reconDiffId: string;
  readonly billLine: ProvenBillLine;
  /** The bill line's amount (the difference's actual_fen), compared with net_fen. */
  readonly expectedFen: bigint;
  /** admin_users.id of the operator (executor_id; voucher operator admin:<id>). */
  readonly operatorId: string;
  /** The server's time of the write-off (the injected Clock, read by the caller). */
  readonly now: Date;
}

export type ProveChannelSuccessResult =
  | {
      readonly kind: 'proven';
      readonly status: 'PAID_API';
      readonly paidAt: Date;
      readonly channelOrderId: string | null;
    }
  | { readonly kind: 'refused'; readonly reason: ProvenSuccessRefusal };

export interface WithdrawalProvenSuccess {
  /**
   * W11 on the caller's transaction. Throws WithdrawalConflictError (20902 withdrawal) when the
   * withdrawal is not APPROVED (or not the app's) or the CAS matched no row.
   */
  proveChannelSuccess(
    trx: Transaction<DB>,
    input: ProveChannelSuccessInput,
  ): Promise<ProveChannelSuccessResult>;
}

export interface WithdrawalProvenSuccessOptions {
  readonly ledger: Ledger;
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  /** content's configuration reader (payout.proven_success_writeoff.enabled). */
  readonly config: PayoutConfigPort;
  /** The job queue (same-transaction enqueue of the attempt-append job). */
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
}

export function createWithdrawalProvenSuccess(
  options: WithdrawalProvenSuccessOptions,
): WithdrawalProvenSuccess {
  void options;
  throw new Error('NotImplemented: createWithdrawalProvenSuccess');
}
