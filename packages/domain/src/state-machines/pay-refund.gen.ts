// 生成物，勿手改。来源：specs/state-machines/pay-refund.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type PayRefundState =
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED';

export const PAY_REFUND_STATES: readonly PayRefundState[] = ['PROCESSING', 'SUCCESS', 'FAILED'];

export type PayRefundEvent =
  | 'APPLY'
  | 'REFUND_SUCCESS'
  | 'REFUND_FAILED';

export const PAY_REFUND_EVENTS: readonly PayRefundEvent[] = ['APPLY', 'REFUND_SUCCESS', 'REFUND_FAILED'];

export interface PayRefundTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (PayRefundState | null | '*')[];
  readonly event: PayRefundEvent | null;
  readonly to: PayRefundState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const PAY_REFUND_TRANSITIONS: readonly PayRefundTransitionRow[] = [
  {
    id: 'RF1',
    from: [null],
    event: 'APPLY',
    to: 'PROCESSING',
    guard: 'BR-PAY-06 ②③：幂等键、业务对象锁后额度校验通过',
    test_id: 'SM-PAY-RF1',
  },
  {
    id: 'RF2',
    from: ['PROCESSING'],
    event: 'REFUND_SUCCESS',
    to: 'SUCCESS',
    guard: '④ 全部核对通过且状态 ∈ refund_success_states；同一事务 CAS + refunded_fen + PAY_REFUND 分录 + 回收任务',
    test_id: 'SM-PAY-RF2',
  },
  {
    id: 'RF3',
    from: ['PROCESSING'],
    event: 'REFUND_FAILED',
    to: 'FAILED',
    guard: '④ 全部核对通过且状态 ∈ refund_fail_states；释放占用额度',
    test_id: 'SM-PAY-RF3',
  },
];

export type PayRefundTransitionResult =
  | { ok: true; to: PayRefundState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionPayRefund(from: PayRefundState | null, event: PayRefundEvent): PayRefundTransitionResult {
  for (const row of PAY_REFUND_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as PayRefundState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
