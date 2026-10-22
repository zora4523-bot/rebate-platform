/** BR-TEXT-06 / BR-WDR-25. Branch identifiers are internal, not response copy.
 * The caller supplies Clock.now() and the earliest transfer attempt through a read port;
 * when no attempt exists, first_attempt_at is null and T is executed_at.
 * W10 is identified by manual_resolution=failed (not merely needs_manual).
 */
export interface WithdrawalDisplayRow {
  readonly status: string;
  readonly review_mode: 'auto' | 'manual' | null;
  readonly auto_decision: Readonly<Record<string, unknown>> | null;
  readonly review_deadline: Date | null;
  readonly executed_at: Date | null;
  readonly first_attempt_at: Date | null;
  readonly needs_manual: boolean;
  readonly manual_resolution: 'paid' | 'failed' | null;
  readonly fail_code: string | null;
  readonly payout_channel: 'alipay' | 'bank_card' | 'wechat';
  readonly channel_state: 'processing' | 'wait_user_confirm' | 'canceling' | null;
  readonly confirm_deadline: Date | null;
}

export type WithdrawalSubTextBranch =
  | 'processing'
  | 'wechat_wait_confirm'
  | 'wechat_confirm_expired'
  | 'wechat_canceling'
  | 'wechat_processing'
  | 'auto_expected_soon'
  | 'manual_review_pending'
  | 'manual_review_overdue'
  | 'channel_processing'
  | 'paying_delayed'
  | 'paid_api'
  | 'paid_manual'
  | 'rejected'
  | 'failed_account'
  | 'failed_other'
  | 'failed_manual';

export function statusTitle(status: string): string {
  void status;
  throw new Error('NotImplemented: statusTitle');
}

export function payoutChannelName(channel: 'alipay' | 'bank_card' | 'wechat'): string {
  void channel;
  throw new Error('NotImplemented: payoutChannelName');
}

export function subTextBranch(row: WithdrawalDisplayRow, now: Date): WithdrawalSubTextBranch {
  void row;
  void now;
  throw new Error('NotImplemented: subTextBranch');
}
