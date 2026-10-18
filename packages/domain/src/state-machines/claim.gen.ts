// 生成物，勿手改。来源：specs/state-machines/claim.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type ClaimState =
  | 'submitted'
  | 'auto_matched'
  | 'manual_review'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export const CLAIM_STATES: readonly ClaimState[] = ['submitted', 'auto_matched', 'manual_review', 'approved', 'rejected', 'cancelled'];

export type ClaimEvent =
  | 'SUBMIT'
  | 'EVIDENCE_ALL_STRONG'
  | 'EVIDENCE_NOT_ALL_STRONG'
  | 'RESOLVE_APPROVED'
  | 'RESOLVE_REJECTED'
  | 'RESOLVE_CANCELLED';

export const CLAIM_EVENTS: readonly ClaimEvent[] = ['SUBMIT', 'EVIDENCE_ALL_STRONG', 'EVIDENCE_NOT_ALL_STRONG', 'RESOLVE_APPROVED', 'RESOLVE_REJECTED', 'RESOLVE_CANCELLED'];

export interface ClaimTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (ClaimState | null | '*')[];
  readonly event: ClaimEvent | null;
  readonly to: ClaimState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const CLAIM_TRANSITIONS: readonly ClaimTransitionRow[] = [
  {
    id: 'C1',
    from: [null],
    event: 'SUBMIT',
    to: 'submitted',
    guard: '按 BR-ATTR-17 的校验顺序受理，至少一个子订单通过全部检查并写入 claim_items（插入 claims 行）；一个都没通过时不建 claim，按 sub_order_id 升序返回第一个子订单的错误码',
    test_id: 'SM-CLM-C1',
  },
  {
    id: 'C2',
    from: ['submitted'],
    event: 'EVIDENCE_ALL_STRONG',
    to: 'auto_matched',
    guard: '证据按子项针对申请人本人算完，全部子项 evidence 为 strong（BR-ATTR-18）；MVP 仍须客服确认，后台置顶并提供一键通过',
    test_id: 'SM-CLM-C2',
  },
  {
    id: 'C3',
    from: ['submitted'],
    event: 'EVIDENCE_NOT_ALL_STRONG',
    to: 'manual_review',
    guard: '证据按子项针对申请人本人算完，至少一个子项不是 strong（按最弱的证据确定，BR-ATTR-18）',
    test_id: 'SM-CLM-C3',
  },
  {
    id: 'C4',
    from: ['auto_matched', 'manual_review'],
    event: 'RESOLVE_APPROVED',
    to: 'approved',
    guard: '全部子项已决，且至少一个子项 approved（BR-ATTR-18）',
    test_id: 'SM-CLM-C4',
  },
  {
    id: 'C5',
    from: ['auto_matched', 'manual_review'],
    event: 'RESOLVE_REJECTED',
    to: 'rejected',
    guard: '全部子项已决，没有 approved，至少一个子项 rejected（BR-ATTR-18）',
    test_id: 'SM-CLM-C5',
  },
  {
    id: 'C6',
    from: ['auto_matched', 'manual_review'],
    event: 'RESOLVE_CANCELLED',
    to: 'cancelled',
    guard: '全部子项已决，且都是 cancelled（同步已自动归因给申请人，BR-ATTR-16、BR-ATTR-18）',
    test_id: 'SM-CLM-C6',
  },
];

export type ClaimTransitionResult =
  | { ok: true; to: ClaimState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionClaim(from: ClaimState | null, event: ClaimEvent): ClaimTransitionResult {
  for (const row of CLAIM_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as ClaimState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
