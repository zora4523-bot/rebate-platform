import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  needsPricing,
  orderFiguresOf,
  priceOrder,
  type OrderCreditTerms,
  type OrderFiguresFacts,
  type OrderFiguresPricingPorts,
  type OrderFiguresRow,
} from './order-figures.ts';

const NOW = new Date('2027-12-15T04:00:00.000Z');
const AFTER_DEADLINE = new Date('2028-01-03T16:00:00.000Z');
const ON: OrderCreditTerms = {
  credit_enabled: true,
  period_offset_months: 1,
  bill_day: 24,
  grace_days: 10,
};
const ROW: OrderFiguresRow = {
  order_id: 'order-1',
  platform: 'jd',
  sub_order_id: 'sub-1',
  buy_type: 'self',
  rebate_status: 'WAITING',
  platform_status: 'RECEIVED',
  hold: false,
  rights_pending: false,
  booked_base_fen: null,
  settle_period: '2027-11',
  union_settled_at: null,
  est_commission_fen: 1000n,
  settle_commission_fen: null,
  commission_version: 0,
};

function facts(patch: Partial<OrderFiguresFacts> = {}): OrderFiguresFacts {
  return {
    row: ROW,
    held: false,
    pricing: null,
    entry: undefined,
    appealed: false,
    terms: ON,
    now: NOW,
    ...patch,
  };
}

const CREDITED: OrderFiguresRow = {
  ...ROW,
  rebate_status: 'CREDITED',
  platform_status: 'SETTLED',
  booked_base_fen: 850n,
};
const ENTRY = {
  credited_fen: 425n,
  settle_adjust_fen: 17n,
  clawback_fen: 100n,
  last_clawback_at: new Date('2027-12-05T02:00:00.000Z'),
};

it('[AC-B1-09p#U4] B_est 未知的 WAITING 单：credit.enabled=off 时月份 null、不逾期，开着时过宽限才逾期', () => {
  expect(orderFiguresOf(facts({ terms: { ...ON, credit_enabled: false } }))).toMatchObject({
    b_est: null,
    est_rebate_fen: null,
    expected_credit_period: null,
    credit_overdue: false,
  });
  expect(orderFiguresOf(facts({ now: AFTER_DEADLINE }))).toMatchObject({
    b_est: null,
    expected_credit_period: '2027-12',
    credit_overdue: true,
  });
});

it('[AC-B1-09p#U5] B_est=0 不显示金额；份额被剥夺给 0；金额取查看者份额', () => {
  expect(orderFiguresOf(facts({ pricing: { baseFen: 0n, viewerShareFen: 0n } }))).toMatchObject({
    b_est: 0n,
    est_rebate_fen: null,
  });
  expect(orderFiguresOf(facts({ pricing: { baseFen: 850n, viewerShareFen: 0n } }))).toMatchObject({
    b_est: 850n,
    est_rebate_fen: 0n,
  });
  expect(orderFiguresOf(facts({ pricing: { baseFen: 850n, viewerShareFen: 425n } }))).toMatchObject(
    { est_rebate_fen: 425n },
  );
});

it('[AC-B1-09p#U6] 已结算：实返按公式，无分录给 0；暂缓、基数 0 都不给实返与扣回', () => {
  expect(orderFiguresOf(facts({ row: CREDITED, entry: ENTRY }))).toMatchObject({
    actual_fen: 342n,
    clawback_fen: 100n,
    has_clawback: true,
    part_clawed_at: '2027-12-05T02:00:00.000Z',
  });
  expect(orderFiguresOf(facts({ row: CREDITED }))).toMatchObject({
    actual_fen: 0n,
    clawback_fen: 0n,
    has_clawback: false,
    part_clawed_at: null,
  });
  for (const input of [
    facts({ row: CREDITED, entry: ENTRY, held: true }),
    facts({ row: { ...CREDITED, booked_base_fen: 0n }, entry: ENTRY }),
  ]) {
    expect(orderFiguresOf(input)).toMatchObject({
      actual_fen: null,
      clawback_fen: null,
      has_clawback: false,
      part_clawed_at: null,
    });
  }
});

it('[AC-B1-09p#U7] CLAWED_BACK：本人无分录时扣回 0 不是 null，有分录照给，都不给实返', () => {
  const row = { ...CREDITED, rebate_status: 'CLAWED_BACK' };
  expect(orderFiguresOf(facts({ row }))).toMatchObject({
    actual_fen: null,
    clawback_fen: 0n,
    has_clawback: false,
  });
  expect(orderFiguresOf(facts({ row, entry: ENTRY }))).toMatchObject({
    actual_fen: null,
    clawback_fen: 100n,
    has_clawback: true,
  });
});

it('[AC-B1-09p#U8] 需要算金额的只有已付款、待入账与暂缓中的已结算单', () => {
  expect(needsPricing(ROW, false)).toBe(true);
  expect(needsPricing({ ...ROW, rebate_status: 'ESTIMATED', platform_status: 'PAID' }, false)).toBe(
    true,
  );
  expect(
    needsPricing({ ...ROW, rebate_status: 'ESTIMATED', platform_status: 'DEPOSIT_PAID' }, false),
  ).toBe(false);
  expect(needsPricing(CREDITED, false)).toBe(false);
  expect(needsPricing(CREDITED, true)).toBe(true);
  expect(needsPricing({ ...CREDITED, booked_base_fen: 0n }, true)).toBe(false);
  expect(needsPricing({ ...ROW, rebate_status: 'VOID' }, false)).toBe(false);
});

const VIEWER = { app_id: 'app_unit', user_id: 'viewer' };
const NO_TRX = {} as Transaction<DB>;

function pricingPorts(tljDeductFen = 0n) {
  return {
    readSnapshot: () =>
      Promise.resolve({
        reserveBp: 1500,
        beneficiaries: [{ userId: 'viewer', role: 'self', ratioBp: 5000, initialStatus: 'active' }],
        forfeitedEvents: [],
      }),
    readTljDeductFen: vi.fn(() => Promise.resolve(tljDeductFen)),
  } satisfies OrderFiguresPricingPorts;
}

const HELD_CREDITED: OrderFiguresRow = {
  ...CREDITED,
  commission_version: 1,
  settle_commission_fen: 1000n,
  booked_base_fen: 510n,
};

it('[AC-B1-09p#U9] 暂缓的已结算单按 booked_base_fen：维权扣减后结算佣金不变、基数变小，预估返 R5a 的金额', async () => {
  const pricing = await priceOrder(pricingPorts(), NO_TRX, VIEWER, HELD_CREDITED);
  expect(pricing).toEqual({ baseFen: 510n, viewerShareFen: 255n });
  expect(orderFiguresOf(facts({ row: HELD_CREDITED, held: true, pricing })).est_rebate_fen).toBe(
    255n,
  );
});

it('[AC-B1-09p#U10] 暂缓的已结算单不再扣淘礼金；佣金字段缺失也按入账基数，入账基数缺失不臆造', async () => {
  const ports = pricingPorts(100n);
  expect(await priceOrder(ports, NO_TRX, VIEWER, HELD_CREDITED)).toEqual({
    baseFen: 510n,
    viewerShareFen: 255n,
  });
  expect(ports.readTljDeductFen).not.toHaveBeenCalled();
  const noCommission = { ...HELD_CREDITED, est_commission_fen: null, settle_commission_fen: null };
  expect(await priceOrder(ports, NO_TRX, VIEWER, noCommission)).toEqual({
    baseFen: 510n,
    viewerShareFen: 255n,
  });
  const noBooked = { ...HELD_CREDITED, booked_base_fen: null };
  expect(await priceOrder(ports, NO_TRX, VIEWER, noBooked)).toBeNull();
});

it('[AC-B1-09p#U11] 待入账单仍按有效佣金换算并扣淘礼金，不看 booked_base_fen', async () => {
  const row: OrderFiguresRow = {
    ...ROW,
    commission_version: 1,
    settle_commission_fen: 1000n,
    booked_base_fen: 510n,
  };
  expect(await priceOrder(pricingPorts(50n), NO_TRX, VIEWER, row)).toEqual({
    baseFen: 800n,
    viewerShareFen: 400n,
  });
  const none = { ...row, est_commission_fen: null, settle_commission_fen: null };
  expect(await priceOrder(pricingPorts(), NO_TRX, VIEWER, none)).toBeNull();
});
