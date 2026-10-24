// B2-06d ③: the pre-transfer review of the payout process (规划/08 BR-WDR-13 ③, BR-WDR-17,
// BR-WDR-05). Pure: the caller reads every input inside pg_advisory_xact_lock(hashtext(
// 'payout_daily:' || app_id)) and hands the values in. The checks run in this fixed order and the
// first one that fails is the W9 hold reason:
//   payout_disabled   payout.enabled is off
//   queue_paused      payout.queue_paused is on
//   channel_disabled  payout.channel_enabled.<channel> off, or payout.channel_paused.<channel> on
//   member_blocked    the member's withdrawal block of BR-WDR-05 (risk frozen / banned with the
//                     expiry judged on the Clock, appealing over either, an effective withdraw hold,
//                     available_fen < 0 under the balance lock, blocked_reason set)
//   single_cap        netFen > singleCapFen
//   daily_cap         dailySentFen + netFen > dailyCapFen, dailySentFen being Σ net_fen of today's
//                     (+08:00) kind=transfer attempts of the app with result pending, success or
//                     unknown (fail and query attempts never count)
// The watermark is not checked here (only at EXECUTE, BR-WDR-18).
//
// Also compiled by the `test` project: erasable syntax only.

/** W9 reasons of the review (withdrawals.hold_reason, BR-WDR-13). */
export type TransferHoldReason =
  | 'payout_disabled'
  | 'queue_paused'
  | 'channel_disabled'
  | 'member_blocked'
  | 'single_cap'
  | 'daily_cap';

/** The complete hold_reason enum: the review's six plus the payer-side result (BR-WDR-17). */
export type WithdrawalHoldReason = TransferHoldReason | 'payer_side_after_transfer';

export interface TransferReviewInput {
  readonly payoutEnabled: boolean;
  readonly queuePaused: boolean;
  /** The withdrawal's channel is enabled and not paused. */
  readonly channelOpen: boolean;
  readonly memberBlocked: boolean;
  readonly netFen: bigint;
  readonly singleCapFen: bigint;
  /** Σ net_fen already sent today (+08:00): pending, success and unknown transfer attempts. */
  readonly dailySentFen: bigint;
  readonly dailyCapFen: bigint;
}

export type TransferReviewVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TransferHoldReason };

export function reviewTransfer(input: TransferReviewInput): TransferReviewVerdict {
  void input;
  throw new Error('NotImplemented: reviewTransfer');
}
