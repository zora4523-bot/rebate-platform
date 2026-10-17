import { expect, it } from 'vitest';
import {
  buildTimeline,
  type TimelineInput,
} from '../../../../apps/api/src/modules/orders/domain/query-rules.ts';

const input: TimelineInput = {
  is_presale: false,
  platform_status: 'PAID',
  display_status: 'PAID',
  deposit_paid_at: '2026-10-01T01:00:00.000Z',
  paid_at: '2026-10-02T02:00:00.000Z',
  received_at: '2026-10-03T03:00:00.000Z',
  credited_at: '2026-11-25T04:00:00.000Z',
  expected_credit_period: '2026-11',
  invalid_at: '2026-11-26T05:00:00.000Z',
  clawed_at: '2026-11-27T06:00:00.000Z',
  part_clawed_at: '2026-11-28T07:00:00.000Z',
};
const tail = [
  { node: 'received', at: input.received_at, period: null },
  { node: 'credit_expected', at: null, period: '2026-11' },
  { node: 'credited', at: input.credited_at, period: null },
];
it('[AC-B1-08l#6] 普通订单时间线节点、时间与结算月份', () => {
  expect(buildTimeline(input)).toEqual([
    { node: 'paid', at: input.paid_at, period: null },
    ...tail,
  ]);
});
it('[AC-B1-08l#7] 预售定金在最前，付款改为尾款', () => {
  expect(buildTimeline({ ...input, is_presale: true })).toEqual([
    { node: 'deposit_paid', at: input.deposit_paid_at, period: null },
    { node: 'final_paid', at: input.paid_at, period: null },
    ...tail,
  ]);
});
it.each([input.deposit_paid_at, null])(
  '[AC-B1-08l#8] 定金阶段保留定金节点，缺时间为 null：%s',
  (deposit) => {
    expect(
      buildTimeline({
        ...input,
        is_presale: true,
        platform_status: 'DEPOSIT_PAID',
        display_status: 'DEPOSIT_PAID',
        deposit_paid_at: deposit,
        received_at: null,
        credited_at: null,
        expected_credit_period: null,
      }),
    ).toEqual([
      { node: 'deposit_paid', at: deposit, period: null },
      { node: 'final_paid', at: null, period: null },
      { node: 'received', at: null, period: null },
      { node: 'credit_expected', at: null, period: null },
      { node: 'credited', at: null, period: null },
    ]);
  },
);
it.each([
  ['INVALID', 'invalid', input.invalid_at],
  ['CLAWED_BACK', 'clawed_back', input.clawed_at],
  ['CREDITED_PART_CLAWED', 'part_clawed_back', input.part_clawed_at],
] as const)('[AC-B1-08l#9] %s 追加 %s，其他事件不追加', (status, node, at) => {
  expect(buildTimeline({ ...input, display_status: status })).toEqual([
    { node: 'paid', at: input.paid_at, period: null },
    ...tail,
    { node, at, period: null },
  ]);
});
it.each(['INVALID', 'CLAWED_BACK'] as const)(
  '[AC-B1-08l#10] %s 缺历史不能捏造发生时间',
  (status) => {
    const result = buildTimeline({
      ...input,
      display_status: status,
      invalid_at: null,
      clawed_at: null,
    });
    expect(result.at(-1)).toEqual({
      node: status === 'INVALID' ? 'invalid' : 'clawed_back',
      at: null,
      period: null,
    });
  },
);
