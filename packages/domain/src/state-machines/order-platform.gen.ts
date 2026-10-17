// 生成物，勿手改。来源：specs/state-machines/order-platform.yaml（字段 platform_status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type OrderPlatformState =
  | 'DEPOSIT_PAID'
  | 'PAID'
  | 'RECEIVED'
  | 'SETTLED'
  | 'INVALID';

export const ORDER_PLATFORM_STATES: readonly OrderPlatformState[] = ['DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED', 'INVALID'];

export type OrderPlatformEvent =
  | 'PLATFORM_DEPOSIT_PAID'
  | 'PLATFORM_PAID'
  | 'PLATFORM_RECEIVED'
  | 'PLATFORM_SETTLED'
  | 'PLATFORM_INVALID'
  | 'PLATFORM_RIGHTS'
  | 'PLATFORM_PUNISH';

export const ORDER_PLATFORM_EVENTS: readonly OrderPlatformEvent[] = ['PLATFORM_DEPOSIT_PAID', 'PLATFORM_PAID', 'PLATFORM_RECEIVED', 'PLATFORM_SETTLED', 'PLATFORM_INVALID', 'PLATFORM_RIGHTS', 'PLATFORM_PUNISH'];

export interface OrderPlatformTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (OrderPlatformState | null | '*')[];
  readonly event: OrderPlatformEvent | null;
  readonly to: OrderPlatformState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const ORDER_PLATFORM_TRANSITIONS: readonly OrderPlatformTransitionRow[] = [
  {
    id: 'P1',
    from: [null],
    event: 'PLATFORM_DEPOSIT_PAID',
    to: 'DEPOSIT_PAID',
    guard: '—',
    test_id: 'SM-PLT-P1',
  },
  {
    id: 'P2',
    from: [null, 'DEPOSIT_PAID'],
    event: 'PLATFORM_PAID',
    to: 'PAID',
    guard: '—',
    test_id: 'SM-PLT-P2',
  },
  {
    id: 'P3',
    from: ['PAID'],
    event: 'PLATFORM_RECEIVED',
    to: 'RECEIVED',
    guard: '—',
    test_id: 'SM-PLT-P3',
  },
  {
    id: 'P4',
    from: ['RECEIVED'],
    event: 'PLATFORM_SETTLED',
    to: 'SETTLED',
    guard: '—',
    test_id: 'SM-PLT-P4',
  },
  {
    id: 'P5',
    from: ['DEPOSIT_PAID', 'PAID'],
    event: 'PLATFORM_SETTLED',
    to: 'SETTLED',
    guard: '此前未给收货',
    test_id: 'SM-PLT-P5',
  },
  {
    id: 'P6',
    from: ['DEPOSIT_PAID', 'PAID', 'RECEIVED'],
    event: 'PLATFORM_INVALID',
    to: 'INVALID',
    guard: '—',
    test_id: 'SM-PLT-P6',
  },
  {
    id: 'P7',
    from: ['SETTLED'],
    event: 'PLATFORM_INVALID',
    to: 'same',
    guard: '—',
    test_id: 'SM-PLT-P7',
  },
  {
    id: 'P8',
    from: ['PAID', 'RECEIVED', 'SETTLED'],
    event: 'PLATFORM_RIGHTS',
    to: 'same',
    guard: '—',
    test_id: 'SM-PLT-P8',
  },
  {
    id: 'P8',
    from: ['PAID', 'RECEIVED', 'SETTLED'],
    event: 'PLATFORM_PUNISH',
    to: 'same',
    guard: '—',
    test_id: 'SM-PLT-P8',
  },
  {
    id: 'P9',
    from: ['INVALID'],
    event: 'PLATFORM_PAID',
    to: 'PAID',
    guard: '平台回传非失效状态',
    test_id: 'SM-PLT-P9',
  },
  {
    id: 'P9',
    from: ['INVALID'],
    event: 'PLATFORM_RECEIVED',
    to: 'RECEIVED',
    guard: '平台回传非失效状态',
    test_id: 'SM-PLT-P9',
  },
  {
    id: 'P9',
    from: ['INVALID'],
    event: 'PLATFORM_SETTLED',
    to: 'SETTLED',
    guard: '平台回传非失效状态',
    test_id: 'SM-PLT-P9',
  },
  {
    id: 'P10',
    kind: 'backward',
    from: ['*'],
    event: null,
    to: 'same',
    guard: '比当前更早阶段的状态码（倒退；按事件对应的阶段与当前状态比较得出，不是单独的事件）',
    test_id: 'SM-PLT-P10',
  },
  {
    id: 'P11',
    from: [null],
    event: 'PLATFORM_RECEIVED',
    to: 'RECEIVED',
    guard: '首次入库即已收货；缺平台收货时间时按 P2 落 PAID，收货事件进待处理表，不进 WAITING（BR-FUND-02）',
    test_id: 'SM-PLT-P11',
  },
  {
    id: 'P12',
    from: [null],
    event: 'PLATFORM_SETTLED',
    to: 'SETTLED',
    guard: '首次入库即已结算',
    test_id: 'SM-PLT-P12',
  },
  {
    id: 'P13',
    from: [null],
    event: 'PLATFORM_INVALID',
    to: 'INVALID',
    guard: '首次入库即失效，且有付款时间；两个付款时间都为空的不入库（BR-ATTR-25）',
    test_id: 'SM-PLT-P13',
  },
  {
    id: 'P14',
    from: ['DEPOSIT_PAID'],
    event: 'PLATFORM_RECEIVED',
    to: 'RECEIVED',
    guard: '此前没见到付款',
    test_id: 'SM-PLT-P14',
  },
  {
    id: 'P15',
    kind: 'same_state',
    from: ['*'],
    event: null,
    to: 'same',
    guard: '与当前状态相同（重复上报，或不同原始码映射到同一状态）',
    test_id: 'SM-PLT-P15',
  },
];

const ORDER_PLATFORM_STAGES: readonly OrderPlatformState[] = ['DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED'];

const ORDER_PLATFORM_EVENT_STATES: Partial<Record<OrderPlatformEvent, OrderPlatformState>> = {
  PLATFORM_DEPOSIT_PAID: 'DEPOSIT_PAID',
  PLATFORM_PAID: 'PAID',
  PLATFORM_RECEIVED: 'RECEIVED',
  PLATFORM_SETTLED: 'SETTLED',
  PLATFORM_INVALID: 'INVALID',
};

export type OrderPlatformTransitionResult =
  | { ok: true; to: OrderPlatformState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionOrderPlatform(from: OrderPlatformState | null, event: OrderPlatformEvent): OrderPlatformTransitionResult {
  for (const row of ORDER_PLATFORM_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as OrderPlatformState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  // 表内没有的组合：先按「事件对应的状态」判定同状态与倒退，其余为表外事件。
  if (from === null) return { ok: false, reason: 'illegal', id: null };
  const reported = ORDER_PLATFORM_EVENT_STATES[event];
  if (reported === from) return { ok: true, to: from, id: 'P15', noop: true };
  const current = ORDER_PLATFORM_STAGES.indexOf(from);
  const reportedStage = reported === undefined ? -1 : ORDER_PLATFORM_STAGES.indexOf(reported);
  if (current >= 0 && reportedStage >= 0 && reportedStage < current) {
    return { ok: false, reason: 'backward', id: 'P10' };
  }
  return { ok: false, reason: 'illegal', id: null };
}
