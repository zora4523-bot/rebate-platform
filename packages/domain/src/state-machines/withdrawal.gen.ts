// 生成物，勿手改。来源：specs/state-machines/withdrawal.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type WithdrawalState =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAYING'
  | 'PAID_API'
  | 'PAID_MANUAL'
  | 'FAILED';

export const WITHDRAWAL_STATES: readonly WithdrawalState[] = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAYING', 'PAID_API', 'PAID_MANUAL', 'FAILED'];

export type WithdrawalEvent =
  | 'APPLY'
  | 'APPROVE'
  | 'REJECT'
  | 'EXECUTE'
  | 'CHANNEL_SUCCESS'
  | 'CHANNEL_FAIL'
  | 'CHANNEL_UNKNOWN'
  | 'MANUAL_PAID'
  | 'HOLD'
  | 'MANUAL_RESOLVE'
  | 'CHANNEL_SUCCESS_PROVEN';

export const WITHDRAWAL_EVENTS: readonly WithdrawalEvent[] = ['APPLY', 'APPROVE', 'REJECT', 'EXECUTE', 'CHANNEL_SUCCESS', 'CHANNEL_FAIL', 'CHANNEL_UNKNOWN', 'MANUAL_PAID', 'HOLD', 'MANUAL_RESOLVE', 'CHANNEL_SUCCESS_PROVEN'];

export interface WithdrawalTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (WithdrawalState | null | '*')[];
  readonly event: WithdrawalEvent | null;
  readonly to: WithdrawalState | 'same';
  readonly alternatives?: readonly WithdrawalState[];
  readonly guard: string;
  readonly test_id: string;
}

export const WITHDRAWAL_TRANSITIONS: readonly WithdrawalTransitionRow[] = [
  {
    id: 'W1',
    from: [null],
    event: 'APPLY',
    to: 'PENDING_REVIEW',
    guard: 'BR-WDR-03 全部通过',
    test_id: 'SM-WDR-W1',
  },
  {
    id: 'W2',
    from: ['PENDING_REVIEW'],
    event: 'APPROVE',
    to: 'APPROVED',
    guard: 'BR-WDR-10；available_fen ≥ 0 且 blocked_reason 为空（BR-WDR-05 (a)）；风控冻结与 withdraw_holds 不影响审核通过',
    test_id: 'SM-WDR-W2',
  },
  {
    id: 'W3',
    from: ['PENDING_REVIEW', 'APPROVED'],
    event: 'REJECT',
    to: 'REJECTED',
    guard: '必填原因码；从 APPROVED 驳回时不得有 pending/success/unknown 转账尝试（BR-WDR-10）；hold_reason=payer_side_after_transfer 的单须先有一次查询结果为「订单不存在」或清单内的明确失败（BR-WDR-17）；系统驳回 NEGATIVE_BALANCE 只针对没有任何转账尝试的单（BR-WDR-05 (a)）',
    test_id: 'SM-WDR-W3',
  },
  {
    id: 'W4',
    from: ['APPROVED'],
    event: 'EXECUTE',
    to: 'PAYING',
    guard: 'BR-WDR-11、12（含该单没有任何转账尝试、available_fen ≥ 0、blocked_reason 为空）；execute_seq +1',
    test_id: 'SM-WDR-W4',
  },
  {
    id: 'W5',
    from: ['PAYING'],
    event: 'CHANNEL_SUCCESS',
    to: 'PAID_API',
    guard: 'needs_manual=false；BR-WDR-14、28',
    test_id: 'SM-WDR-W5',
  },
  {
    id: 'W6',
    from: ['PAYING'],
    event: 'CHANNEL_FAIL',
    to: 'FAILED',
    guard: 'needs_manual=false；BR-WDR-14、28',
    test_id: 'SM-WDR-W6',
  },
  {
    id: 'W7',
    from: ['PAYING'],
    event: 'CHANNEL_UNKNOWN',
    to: 'same',
    guard: '—',
    test_id: 'SM-WDR-W7',
  },
  {
    id: 'W8',
    from: ['APPROVED'],
    event: 'MANUAL_PAID',
    to: 'PAID_MANUAL',
    guard: 'BR-WDR-16；hold_reason=payer_side_after_transfer 的单须先有一次查询结果为「订单不存在」或清单内的明确失败（BR-WDR-17）',
    test_id: 'SM-WDR-W8',
  },
  {
    id: 'W9',
    from: ['PAYING'],
    event: 'HOLD',
    to: 'APPROVED',
    guard: '发出转账前复核未过（BR-WDR-13 ③），或转账返回付款方侧码（BR-WDR-17、28）',
    test_id: 'SM-WDR-W9',
  },
  {
    id: 'W10',
    from: ['PAYING'],
    event: 'MANUAL_RESOLVE',
    to: 'PAID_API',
    alternatives: ['FAILED'],
    guard: 'needs_manual=true；BR-WDR-15；到 PAID_API / FAILED 由调用方按处置结果分流',
    test_id: 'SM-WDR-W10',
  },
  {
    id: 'W11',
    from: ['APPROVED'],
    event: 'CHANNEL_SUCCESS_PROVEN',
    to: 'PAID_API',
    guard: 'hold_reason=payer_side_after_transfer；该单唯一的转账尝试 result=fail；通道成功凭证（查询返回成功，或含该 out_biz_no 的账单行，金额 = net_fen）；有权限者 step-up（权限点同 W10 未知处置）；开关 payout.proven_success_writeoff.enabled=on',
    test_id: 'SM-WDR-W11',
  },
];

export type WithdrawalTransitionResult =
  | { ok: true; to: WithdrawalState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

// outcome（可选）：该行的处置结果，须是 to 或 alternatives 之一；不传时取 to（基准值）。
export function transitionWithdrawal(
  from: WithdrawalState | null,
  event: WithdrawalEvent,
  outcome?: WithdrawalState,
): WithdrawalTransitionResult {
  for (const row of WITHDRAWAL_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      if (outcome !== undefined && outcome !== from) {
        return { ok: false, reason: 'illegal', id: null };
      }
      return { ok: true, to: from as WithdrawalState, id: row.id, noop: true };
    }
    if (outcome === undefined || outcome === row.to) {
      return { ok: true, to: row.to, id: row.id, noop: false };
    }
    if (row.alternatives?.includes(outcome) === true) {
      return { ok: true, to: outcome, id: row.id, noop: false };
    }
    return { ok: false, reason: 'illegal', id: null };
  }
  return { ok: false, reason: 'illegal', id: null };
}
