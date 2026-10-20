import { expect, it } from 'vitest';
import {
  classifySettlementBillOrder,
  deriveSettlementBillStatus,
  expectedSettlementCredit,
  splitSettlementBillBatches,
  type ClassifyBillOrderInput,
} from './index.ts';

const base: ClassifyBillOrderInput = {
  bill_period: '2026-10',
  generation_started_at: at('2026-11-24T00:01:00+08:00'),
  order: {
    rebate_status: 'WAITING',
    settle_period: '2026-10',
    hold: false,
    rights_pending: false,
    snapshots: [{ commission_version: 1, base_fen: 800n }],
    union_authoritative: false,
  },
  settlement: {
    source: 'API',
    created_at: at('2026-11-20T10:00:00+08:00'),
    settle_commission_fen: 1000n,
    b_settle_fen: 800n,
  },
  match_tolerance_fen: 0n,
};

it('[AC-B2-04f#u1] 最大版本重复的快照视为损坏，抛 RangeError', () => {
  expect(() =>
    classifySettlementBillOrder({
      ...base,
      order: {
        ...base.order!,
        snapshots: [
          { commission_version: 2, base_fen: 800n },
          { commission_version: 2, base_fen: 900n },
        ],
      },
    }),
  ).toThrow(RangeError);
});

it('[AC-B2-04f#u2] 账单月格式不合法或容差为负都拒绝', () => {
  expect(() => classifySettlementBillOrder({ ...base, bill_period: '2026-13' })).toThrow(
    RangeError,
  );
  expect(() => classifySettlementBillOrder({ ...base, match_tolerance_fen: -1n })).toThrow();
});

it('[AC-B2-04f#u3] WAITING 缺 settle_period 是损坏数据', () => {
  expect(() =>
    classifySettlementBillOrder({ ...base, order: { ...base.order!, settle_period: null } }),
  ).toThrow(RangeError);
});

it('[AC-B2-04f#u4] 候选里重复的 order_key 拒绝，不重复入批', () => {
  const row = {
    platform: 'taobao',
    order_key: 'taobao:1',
    credit_enabled: true,
    result: 'candidate',
  } as const;
  expect(() => splitSettlementBillBatches('2026-10', [row, row], 10)).toThrow(RangeError);
});

it('[AC-B2-04f#u5] 定时批次缺 scheduled_at 拒绝派生', () => {
  expect(() =>
    deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 1,
      batches: [{ round: 1, status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: null }],
      now: at('2026-11-25T10:00:00+08:00'),
    }),
  ).toThrow(RangeError);
});

it('[AC-B2-04f#u6] 账单日与偏移超出可用范围时拒绝', () => {
  const input = {
    rebate_status: 'WAITING',
    settle_period: '2026-10',
    union_settled_at: null,
    hold: false,
    rights_pending: false,
    credit_enabled: true,
    period_offset_months: 1,
    bill_day: 24,
    grace_days: 10,
    now: at('2026-11-24T08:00:00+08:00'),
  } as const;
  expect(() => expectedSettlementCredit({ ...input, bill_day: 29 })).toThrow(RangeError);
  expect(() => expectedSettlementCredit({ ...input, period_offset_months: -1 })).toThrow(
    RangeError,
  );
});

function at(iso: string): Date {
  // eslint-disable-next-line no-restricted-syntax -- 由固定夹具字符串构造，不读墙钟（同 invite.test.ts）
  return new Date(iso);
}
