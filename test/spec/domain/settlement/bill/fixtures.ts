import type {
  BillBatchFacts,
  BillOrderFacts,
  BillSettlementFacts,
  BillValidatedOrder,
  ClassifyBillOrderInput,
  ExpectedCreditInput,
} from '@couli/domain';

// 所有时刻都是固定夹具，不读取宿主时钟；金额期望手算，不调用待测函数作 oracle。
export function order(overrides: Partial<BillOrderFacts> = {}): BillOrderFacts {
  return {
    rebate_status: 'WAITING',
    settle_period: '2026-10',
    hold: false,
    rights_pending: false,
    snapshots: [{ commission_version: 1, base_fen: 800n }],
    union_authoritative: false,
    ...overrides,
  };
}

export function settlement(overrides: Partial<BillSettlementFacts> = {}): BillSettlementFacts {
  return {
    source: 'API',
    created_at: new Date('2026-11-20T10:00:00+08:00'),
    settle_commission_fen: 1000n,
    b_settle_fen: 800n,
    ...overrides,
  };
}

export function classification(
  overrides: Partial<ClassifyBillOrderInput> = {},
): ClassifyBillOrderInput {
  return {
    bill_period: '2026-10',
    generation_started_at: new Date('2026-11-24T00:01:00+08:00'),
    order: order(),
    settlement: settlement(),
    match_tolerance_fen: 0n,
    ...overrides,
  };
}

export function validated(
  platform: string,
  sub_order_id: string,
  overrides: Partial<BillValidatedOrder> = {},
): BillValidatedOrder {
  return {
    platform,
    order_key: `${platform}:${sub_order_id}`,
    credit_enabled: true,
    result: 'candidate',
    ...overrides,
  };
}

export function batch(overrides: Partial<BillBatchFacts> = {}): BillBatchFacts {
  return { round: 1, status: 'DRAFT', settle_mode: 'IMMEDIATE', scheduled_at: null, ...overrides };
}

export function credit(overrides: Partial<ExpectedCreditInput> = {}): ExpectedCreditInput {
  return {
    rebate_status: 'WAITING',
    settle_period: '2026-10',
    union_settled_at: null,
    hold: false,
    rights_pending: false,
    credit_enabled: true,
    period_offset_months: 1,
    bill_day: 24,
    grace_days: 10,
    now: new Date('2026-11-24T08:00:00+08:00'),
    ...overrides,
  };
}
