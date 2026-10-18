// 生成物，勿手改。来源：specs/state-machines/claim-item.yaml（字段 decision）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type ClaimItemState =
  | 'approved'
  | 'rejected'
  | 'cancelled';

export const CLAIM_ITEM_STATES: readonly ClaimItemState[] = ['approved', 'rejected', 'cancelled'];

export type ClaimItemEvent =
  | 'APPROVE'
  | 'REJECT'
  | 'CANCEL';

export const CLAIM_ITEM_EVENTS: readonly ClaimItemEvent[] = ['APPROVE', 'REJECT', 'CANCEL'];

export interface ClaimItemTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (ClaimItemState | null | '*')[];
  readonly event: ClaimItemEvent | null;
  readonly to: ClaimItemState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const CLAIM_ITEM_TRANSITIONS: readonly ClaimItemTransitionRow[] = [
  {
    id: 'I1',
    from: [null],
    event: 'APPROVE',
    to: 'approved',
    guard: '待审子项由客服通过，且按 BR-ATTR-20 加锁复查订单仍未归属（重读 user_id 为空）；P1 开启 claim.auto_approve_strong 后 strong 子项直接通过同此',
    test_id: 'SM-CLI-I1',
  },
  {
    id: 'I2',
    from: [null],
    event: 'REJECT',
    to: 'rejected',
    guard: '待审子项被驳回，reject_reason 必填：客服只能选 NO_EVIDENCE、EXPIRED_CLICK、NOT_TRACKED、OTHER_TLJ、FRAUD、OTHER 六个；系统写 NOT_IN_POOL（他人先通过、后台改派、同步归属给他人）或 ORDER_INVALID（审核时订单 rebate_status 已为 VOID）',
    test_id: 'SM-CLI-I2',
  },
  {
    id: 'I3',
    from: [null],
    event: 'CANCEL',
    to: 'cancelled',
    guard: '待审子项的订单经同步自动归属、或通过时复查发现已归属，且归属的 user_id 等于申请人（BR-ATTR-16、BR-ATTR-20 ②）',
    test_id: 'SM-CLI-I3',
  },
];

export type ClaimItemTransitionResult =
  | { ok: true; to: ClaimItemState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionClaimItem(from: ClaimItemState | null, event: ClaimItemEvent): ClaimItemTransitionResult {
  for (const row of CLAIM_ITEM_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as ClaimItemState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
