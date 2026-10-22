// 生成物，勿手改。来源：specs/state-machines/pay-order.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type PayOrderState =
  | 'PENDING'
  | 'PAID'
  | 'CLOSED';

export const PAY_ORDER_STATES: readonly PayOrderState[] = ['PENDING', 'PAID', 'CLOSED'];

export type PayOrderEvent =
  | 'CREATE'
  | 'PAY_SUCCESS'
  | 'CLOSE';

export const PAY_ORDER_EVENTS: readonly PayOrderEvent[] = ['CREATE', 'PAY_SUCCESS', 'CLOSE'];

export interface PayOrderTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (PayOrderState | null | '*')[];
  readonly event: PayOrderEvent | null;
  readonly to: PayOrderState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const PAY_ORDER_TRANSITIONS: readonly PayOrderTransitionRow[] = [
  {
    id: 'PO1',
    from: [null],
    event: 'CREATE',
    to: 'PENDING',
    guard: 'BR-PAY-01 ①②④ 全部通过；同一业务对象无 PENDING / PAID 单（BR-PAY-02 唯一约束）',
    test_id: 'SM-PAY-PO1',
  },
  {
    id: 'PO2',
    from: ['PENDING'],
    event: 'PAY_SUCCESS',
    to: 'PAID',
    guard: '只凭 BR-PAY-04 判定的支付成功：验签通过、应用与商户标识是我方、商户单号对应、金额等于 amount_fen、渠道状态 ∈ pay.<pay_channel>.success_states；同一事务写 PAY_RECEIPT 分录与开通任务',
    test_id: 'SM-PAY-PO2',
  },
  {
    id: 'PO3',
    from: ['PENDING'],
    event: 'CLOSE',
    to: 'CLOSED',
    guard: 'BR-PAY-05：从未下单且未返回调起参数可直接关；否则先查询，渠道明确已关闭才关；不存在须过 expire_at + close_grace_minutes 再查',
    test_id: 'SM-PAY-PO3',
  },
];

export type PayOrderTransitionResult =
  | { ok: true; to: PayOrderState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionPayOrder(from: PayOrderState | null, event: PayOrderEvent): PayOrderTransitionResult {
  for (const row of PAY_ORDER_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as PayOrderState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
