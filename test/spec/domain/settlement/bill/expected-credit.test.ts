import { expectedSettlementCredit } from '@couli/domain';
import { expect, it } from 'vitest';
import { credit } from './fixtures.ts';

// BR-FUND-04 ⑪；日期矩阵按 +08:00 手算，不用 calendar 或待测函数生成期望。
it.each([
  ['2026-10', 1, '2026-11'],
  ['2026-12', 1, '2027-01'],
  ['2024-01', 1, '2024-02'],
  ['2024-02', 1, '2024-03'],
  ['2026-10', 0, '2026-10'],
  ['2026-11', 2, '2027-01'],
  ['2026-12', 14, '2028-02'],
] as const)(
  '[AC-B2-04f#37] 无联盟结算时间时收货月 %s 加 %s 个月为 %s',
  (period, offset, expected) => {
    expect(
      expectedSettlementCredit(
        credit({
          settle_period: period,
          period_offset_months: offset,
          now: new Date('2024-01-01T00:00:00+08:00'),
        }),
      ),
    ).toEqual({ expected_credit_period: expected, credit_overdue: false });
  },
);

it.each([
  ['2026-10-31T15:59:59.999Z', '2026-10'],
  ['2026-10-31T16:00:00.000Z', '2026-11'],
  ['2026-10-31T23:59:59.999Z', '2026-11'],
  ['2026-12-31T15:59:59.999Z', '2026-12'],
  ['2026-12-31T16:00:00.000Z', '2027-01'],
  ['2024-02-29T15:59:59.999Z', '2024-02'],
  ['2024-02-29T16:00:00.000Z', '2024-03'],
  ['2026-02-28T16:00:00.000Z', '2026-03'],
] as const)('[AC-B2-04f#38] 联盟时刻 %s 按北京时间归月 %s，忽略推算偏移', (instant, expected) => {
  expect(
    expectedSettlementCredit(
      credit({
        union_settled_at: new Date(instant),
        period_offset_months: 14,
        now: new Date('2024-01-01T00:00:00+08:00'),
      }),
    ),
  ).toEqual({ expected_credit_period: expected, credit_overdue: false });
});

it('[AC-B2-04f#39] 联盟月份即使早于推算月也取联盟，不取 max 或顺延到下个月', () => {
  expect(
    expectedSettlementCredit(
      credit({
        union_settled_at: new Date('2026-10-28T18:00:00+08:00'),
        now: new Date('2026-10-29T07:00:00+08:00'),
      }),
    ),
  ).toEqual({ expected_credit_period: '2026-10', credit_overdue: false });
});

it('[AC-B2-04f#40] 联盟晚到月份直接更新预计月份，保留原收货月', () => {
  const input = credit({ now: new Date('2026-12-02T12:00:00+08:00') });
  expect([
    expectedSettlementCredit(input),
    expectedSettlementCredit({ ...input, union_settled_at: new Date('2026-12-02T10:00:00+08:00') }),
    input.settle_period,
  ]).toEqual([
    { expected_credit_period: '2026-11', credit_overdue: false },
    { expected_credit_period: '2026-12', credit_overdue: false },
    '2026-10',
  ]);
});

it.each([
  ['2026-11-24T00:00:00+08:00', false],
  ['2026-11-30T23:59:59.999+08:00', false],
  ['2026-12-01T00:00:00+08:00', false],
  ['2026-12-04T00:00:00+08:00', false],
  ['2026-12-04T23:59:59.999+08:00', false],
  ['2026-12-05T00:00:00+08:00', true],
  ['2026-12-04T16:00:00Z', true],
  ['2026-12-05T07:59:59.999+08:00', true],
] as const)(
  '[AC-B2-04f#41] 11 月 24 日加 10 天到 12 月 4 日，当前 %s 逾期为 %s',
  (now, overdue) => {
    expect(expectedSettlementCredit(credit({ now: new Date(now) }))).toEqual({
      expected_credit_period: '2026-11',
      credit_overdue: overdue,
    });
  },
);

it.each([
  ['2024-02', '2024-03-05T23:59:59.999+08:00', false],
  ['2024-02', '2024-03-06T00:00:00+08:00', true],
  ['2026-02', '2026-03-06T23:59:59.999+08:00', false],
  ['2026-02', '2026-03-07T00:00:00+08:00', true],
  ['2026-12', '2027-01-03T23:59:59.999+08:00', false],
  ['2026-12', '2027-01-04T00:00:00+08:00', true],
  ['2027-01', '2027-02-03T23:59:59.999+08:00', false],
  ['2027-01', '2027-02-04T00:00:00+08:00', true],
] as const)('[AC-B2-04f#42] 预计 %s 的宽限跨月、跨年与闰年边界 %s', (period, now, overdue) => {
  expect(
    expectedSettlementCredit(
      credit({ settle_period: period, period_offset_months: 0, now: new Date(now) }),
    ),
  ).toEqual({ expected_credit_period: period, credit_overdue: overdue });
});

it.each([
  [22, 2, '2026-11-24T23:59:59.999+08:00', false],
  [22, 2, '2026-11-25T00:00:00+08:00', true],
  [28, 0, '2026-11-28T23:59:59.999+08:00', false],
  [28, 0, '2026-11-29T00:00:00+08:00', true],
] as const)(
  '[AC-B2-04f#43] 账单日 %s、宽限 %s 来自入参，在 %s 判断日期严格晚于',
  (billDay, grace, now, overdue) => {
    expect(
      expectedSettlementCredit(
        credit({ bill_day: billDay, grace_days: grace, now: new Date(now) }),
      ),
    ).toEqual({ expected_credit_period: '2026-11', credit_overdue: overdue });
  },
);

it.each([
  { hold: true, rights_pending: false, credit_enabled: true },
  { hold: false, rights_pending: true, credit_enabled: true },
  { hold: false, rights_pending: false, credit_enabled: false },
  { hold: true, rights_pending: true, credit_enabled: false },
])('[AC-B2-04f#44] 暂停或平台关闭不给预计月份和逾期标记：%j', (flags) => {
  const input = credit({ ...flags, now: new Date('2027-01-01T00:00:00+08:00') });
  expect([
    expectedSettlementCredit(input),
    expectedSettlementCredit({ ...input, union_settled_at: new Date('2026-11-20T08:00:00+08:00') }),
  ]).toEqual([
    { expected_credit_period: null, credit_overdue: false },
    { expected_credit_period: null, credit_overdue: false },
  ]);
});

it.each(['UNATTRIBUTED', 'ESTIMATED', 'CREDITED', 'VOID', 'CLAWED_BACK'] as const)(
  '[AC-B2-04f#45] %s 不是 WAITING，历史结算时间不能令其显示待入账或逾期',
  (status) => {
    expect(
      expectedSettlementCredit(
        credit({
          rebate_status: status,
          union_settled_at: new Date('2026-11-20T08:00:00+08:00'),
          now: new Date('2027-01-01T00:00:00+08:00'),
        }),
      ),
    ).toEqual({ expected_credit_period: null, credit_overdue: false });
  },
);

it('[AC-B2-04f#46] 暂缓解除后仍按原预计月份判断逾期，不从解除日重新起宽限', () => {
  const input = credit({ hold: true, now: new Date('2026-12-05T07:00:00+08:00') });
  expect([
    expectedSettlementCredit(input),
    expectedSettlementCredit({ ...input, hold: false }),
  ]).toEqual([
    { expected_credit_period: null, credit_overdue: false },
    { expected_credit_period: '2026-11', credit_overdue: true },
  ]);
});

it('[AC-B2-04f#47] 预计月份与逾期计算可重放且不修改输入时刻', () => {
  const input = Object.freeze(
    credit({
      union_settled_at: new Date('2026-11-20T08:00:00+08:00'),
      now: new Date('2026-12-05T07:00:00+08:00'),
    }),
  );
  const before = structuredClone(input);
  const first = expectedSettlementCredit(input);
  expect({ first, again: expectedSettlementCredit(input), input }).toEqual({
    first: { expected_credit_period: '2026-11', credit_overdue: true },
    again: { expected_credit_period: '2026-11', credit_overdue: true },
    input: before,
  });
});
