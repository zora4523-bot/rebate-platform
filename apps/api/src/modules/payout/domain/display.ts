// B2-05f: the user-facing display judgement of a withdrawal (规划/08 BR-TEXT-06 状态标题, BR-WDR-25
// 副文案分支表, BR-WDR-08 状态机). Pure: no clock, no I/O; the caller supplies Clock.now() and the
// earliest transfer attempt (first_attempt_at) through its read port. Branch identifiers are
// internal keys for the client dictionary and the earnings tool, never response copy.
//
// Also compiled by the `test` project: erasable syntax only.
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

/** BR-TEXT-06: the status titles; an unknown (future) status reads as 处理中. */
const STATUS_TITLES: Readonly<Record<string, string>> = Object.freeze({
  PENDING_REVIEW: '审核中',
  APPROVED: '审核中',
  PAYING: '打款中',
  PAID_API: '已到账',
  PAID_MANUAL: '已到账',
  REJECTED: '未通过',
  FAILED: '打款未成功',
});
const UNKNOWN_TITLE = '处理中';

const CHANNEL_NAMES: Readonly<Record<'alipay' | 'bank_card' | 'wechat', string>> = Object.freeze({
  alipay: '支付宝',
  bank_card: '银行卡',
  wechat: '微信零钱',
});

/** BR-WDR-25: the「预计几分钟内到账」promise ends two hours after the transfer started (T + 2h). */
const DELAY_AFTER_MS = 2 * 3_600_000;
/**
 * BR-TEXT-08: the account-type failure codes that offer「修改收款账号」, code by code (D10-228 ②,
 * not a PAYEE_ prefix). The 08 sample codes until the sandbox run (BR-WDR-22 ⑤) fills the
 * definite-failure list; extending it is a code change under review (BR-TEXT-08 细则 边界).
 */
const ACCOUNT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'PAYEE_NOT_EXIST',
  'PAYEE_USER_INFO_ERROR',
  'PAYEE_ACCOUNT_STATUS_ERROR',
]);

export function statusTitle(status: string): string {
  return Object.hasOwn(STATUS_TITLES, status) ? STATUS_TITLES[status]! : UNKNOWN_TITLE;
}

export function payoutChannelName(channel: 'alipay' | 'bank_card' | 'wechat'): string {
  return CHANNEL_NAMES[channel];
}

/** BR-WDR-25 fail_action: only an account-type failure offers「修改收款账号」. */
export function isAccountFailure(failCode: string | null): boolean {
  return failCode !== null && ACCOUNT_FAILURE_CODES.has(failCode);
}

/**
 * The automatic path: decided auto, not pulled to manual, not blocked at execution, and not a
 * WeChat withdrawal (BR-WDR-25: the「预计几分钟内到账」promise never applies to 微信零钱, whose
 * confirmation steps have their own rows).
 */
function onAutoPath(row: WithdrawalDisplayRow): boolean {
  if (row.review_mode !== 'auto' || row.needs_manual || row.payout_channel === 'wechat') {
    return false;
  }
  return !(row.auto_decision !== null && 'execute_blocked' in row.auto_decision);
}

/** T: the first transfer attempt, else the execution instant; null before any transfer. */
function transferStart(row: WithdrawalDisplayRow): Date | null {
  return row.first_attempt_at ?? row.executed_at;
}

function delayed(row: WithdrawalDisplayRow, now: Date): boolean {
  const start = transferStart(row);
  return start !== null && now.getTime() - start.getTime() >= DELAY_AFTER_MS;
}

function wechatBranch(row: WithdrawalDisplayRow, now: Date): WithdrawalSubTextBranch | null {
  if (row.payout_channel !== 'wechat' || row.needs_manual) return null;
  if (row.channel_state === 'wait_user_confirm') {
    // D10-228 ②: no confirm_deadline recorded yet → still「处理中」(BR-WDR-25 wechat_processing),
    // not「确认已过期」; expiry is only judged against a recorded deadline.
    const deadline = row.confirm_deadline;
    if (deadline === null) return 'wechat_processing';
    return now.getTime() < deadline.getTime() ? 'wechat_wait_confirm' : 'wechat_confirm_expired';
  }
  if (row.channel_state === 'canceling') return 'wechat_canceling';
  return delayed(row, now) ? null : 'wechat_processing';
}

/**
 * BR-WDR-25: the first matching row of the sub-text table, top to bottom. An unknown (future)
 * status has a title (BR-TEXT-06「处理中」) but no sub-text branch → null (D10-228 ②).
 */
export function subTextBranch(
  row: WithdrawalDisplayRow,
  now: Date,
): WithdrawalSubTextBranch | null {
  switch (row.status) {
    case 'PENDING_REVIEW': {
      if (row.auto_decision === null) return 'processing';
      if (row.review_mode === 'manual' && row.review_deadline !== null) {
        return now.getTime() < row.review_deadline.getTime()
          ? 'manual_review_pending'
          : 'manual_review_overdue';
      }
      return onAutoPath(row) ? 'auto_expected_soon' : 'processing';
    }
    case 'APPROVED':
      return onAutoPath(row) ? 'auto_expected_soon' : 'processing';
    case 'PAYING': {
      const wechat = wechatBranch(row, now);
      if (wechat !== null) return wechat;
      if (row.needs_manual || delayed(row, now)) return 'paying_delayed';
      return onAutoPath(row) ? 'auto_expected_soon' : 'channel_processing';
    }
    case 'PAID_API':
      return 'paid_api';
    case 'PAID_MANUAL':
      return 'paid_manual';
    case 'REJECTED':
      return 'rejected';
    case 'FAILED':
      if (row.manual_resolution === 'failed') return 'failed_manual';
      return isAccountFailure(row.fail_code) ? 'failed_account' : 'failed_other';
    default:
      return null;
  }
}
