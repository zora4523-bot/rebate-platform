import {
  deriveSettlementBillStatus,
  type BillBatchFacts,
  type SettlementBillStatus,
} from '@couli/domain';
import { expect, it } from 'vitest';
import { batch } from './fixtures.ts';

const now = new Date('2026-11-25T10:00:00+08:00');
const future = new Date('2026-11-25T10:00:00.001+08:00');
const past = new Date('2026-11-25T09:59:59.999+08:00');

const cases: readonly {
  name: string;
  batches: readonly BillBatchFacts[];
  expected: SettlementBillStatus;
}[] = [
  { name: '尚无批次不宣称已结算', batches: [], expected: '已出账' },
  { name: '待人工确认', batches: [batch()], expected: '已出账' },
  {
    name: '全部驳回',
    batches: [batch({ status: 'CANCELLED' }), batch({ status: 'CANCELLED' })],
    expected: '已出账',
  },
  { name: '立即结算确认后待启动', batches: [batch({ status: 'CONFIRMED' })], expected: '结算中' },
  {
    name: '定时未到',
    batches: [batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: future })],
    expected: '待结算',
  },
  {
    name: '定时恰好到点',
    batches: [batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: now })],
    expected: '结算中',
  },
  {
    name: '定时已经过点',
    batches: [batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: past })],
    expected: '结算中',
  },
  { name: '执行中', batches: [batch({ status: 'EXECUTING' })], expected: '结算中' },
  { name: '部分执行停止', batches: [batch({ status: 'PARTIAL' })], expected: '结算中' },
  {
    name: '本轮全部完成',
    batches: [batch({ status: 'DONE' }), batch({ status: 'DONE' })],
    expected: '已结算',
  },
  {
    name: '完成和驳回混合',
    batches: [batch({ status: 'DONE' }), batch({ status: 'CANCELLED' })],
    expected: '已结算',
  },
  {
    name: '已完成但还有部分执行',
    batches: [batch({ status: 'DONE' }), batch({ status: 'PARTIAL' })],
    expected: '结算中',
  },
  {
    name: '已完成但还有执行中',
    batches: [batch({ status: 'DONE' }), batch({ status: 'EXECUTING' })],
    expected: '结算中',
  },
  {
    name: '已完成但还有未来定时',
    batches: [
      batch({ status: 'DONE' }),
      batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: future }),
    ],
    expected: '待结算',
  },
  {
    name: '一批到时另一批未来',
    batches: [
      batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: future }),
      batch({ status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: now }),
    ],
    expected: '结算中',
  },
  { name: '存在未确认批次', batches: [batch({ status: 'DONE' }), batch()], expected: '已出账' },
];

it.each(cases)('[AC-B2-04f#29] 最近一轮状态：$name → $expected', ({ batches, expected }) => {
  expect(
    deriveSettlementBillStatus({ generation_complete: true, latest_round: 1, batches, now }),
  ).toBe(expected);
});

it.each(cases)('[AC-B2-04f#30] 生成尚未完成时 $name 都保持出账中', ({ batches }) => {
  expect(
    deriveSettlementBillStatus({ generation_complete: false, latest_round: 1, batches, now }),
  ).toBe('出账中');
});

it('[AC-B2-04f#31] 首批完成后新补充轮次可回到已出账，不能被历史 DONE 覆盖', () => {
  expect(
    deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 2,
      batches: [batch({ round: 1, status: 'DONE' }), batch({ round: 2 })],
      now,
    }),
  ).toBe('已出账');
});

it('[AC-B2-04f#32] 历史 PARTIAL 或 DRAFT 不污染最近一轮已完成状态', () => {
  expect(
    deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 3,
      batches: [
        batch({ round: 1, status: 'PARTIAL' }),
        batch({ round: 2 }),
        batch({ round: 3, status: 'DONE' }),
      ],
      now,
    }),
  ).toBe('已结算');
});

it('[AC-B2-04f#33] 最近一轮全部取消不能退回使用上一轮 DONE', () => {
  expect(
    deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 2,
      batches: [batch({ round: 1, status: 'DONE' }), batch({ round: 2, status: 'CANCELLED' })],
      now,
    }),
  ).toBe('已出账');
});

it('[AC-B2-04f#34] 最近一轮暂未生成批次，不借用历史 DONE 宣称已结算', () => {
  const batches = [batch({ round: 1, status: 'DONE' })];
  expect([
    deriveSettlementBillStatus({ generation_complete: false, latest_round: 2, batches, now }),
    deriveSettlementBillStatus({ generation_complete: true, latest_round: 2, batches, now }),
  ]).toEqual(['出账中', '已出账']);
});

it('[AC-B2-04f#35] 同一时刻的不同偏移写法不改变定时到期判断', () => {
  const batches = [
    batch({
      status: 'CONFIRMED',
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date('2026-11-25T02:00:00Z'),
    }),
  ];
  expect(
    deriveSettlementBillStatus({ generation_complete: true, latest_round: 1, batches, now }),
  ).toBe('结算中');
});

it('[AC-B2-04f#36] 账单派生不修改批次或时间，输入顺序不影响结果', () => {
  const batches = Object.freeze([
    Object.freeze(batch({ status: 'DONE' })),
    Object.freeze(batch({ status: 'PARTIAL' })),
  ]);
  const before = structuredClone({ batches, now });
  expect([
    deriveSettlementBillStatus({ generation_complete: true, latest_round: 1, batches, now }),
    deriveSettlementBillStatus({
      generation_complete: true,
      latest_round: 1,
      batches: [...batches].reverse(),
      now,
    }),
    { batches, now },
  ]).toEqual(['结算中', '结算中', before]);
});
