import { expect, it } from 'vitest';
import { planCommissionSnapshot } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, DEPOSIT, FIRST_PAID, MODIFIED, NOW, PAID, input } from './plan-kit.ts';

it('[AC-B1-08k#14] 非预售优先平台付款时间，不用修改/观察时间', () => {
  expect(planCommissionSnapshot(input())).toMatchObject({
    kind: 'call',
    input: { paidAt: PAID, paidAtSource: 'platform' },
  });
});

it('[AC-B1-08k#15] 预售尾款时间不同于定金时间，使用尾款平台时间', () => {
  const i = input();
  expect(
    planCommissionSnapshot({
      ...i,
      order: { ...i.order, is_presale: true, deposit_paid_at: DEPOSIT },
    }),
  ).toMatchObject({ kind: 'call', input: { paidAt: PAID, paidAtSource: 'platform' } });
});

it.each([null, at(DEPOSIT.toISOString())])(
  '[AC-B1-08k#16] 预售缺尾款或仍是定金时间 %s，跨入 PAID+ 取该条 modified_at',
  (paid_at) => {
    const i = input();
    expect(
      planCommissionSnapshot({
        ...i,
        order: { ...i.order, is_presale: true, deposit_paid_at: DEPOSIT, paid_at },
      }),
    ).toMatchObject({
      kind: 'call',
      input: { paidAt: MODIFIED, paidAtSource: 'platform_modified' },
    });
  },
);

it('[AC-B1-08k#17] 当前 P2 缺平台时间时取本次首个已付历史时刻', () => {
  const i = input();
  expect(
    planCommissionSnapshot({
      ...i,
      firstPaidAt: NOW,
      incoming: { ...i.incoming, modified_at: null },
      order: { ...i.order, is_presale: true, deposit_paid_at: DEPOSIT, paid_at: null },
    }),
  ).toMatchObject({ kind: 'call', input: { paidAt: NOW, paidAtSource: 'observed' } });
});

it('[AC-B1-08k#18] 晚归属不得使用本次修改时间，observed 取旧的首条已付历史', () => {
  const i = input();
  expect(
    planCommissionSnapshot({
      ...i,
      movedToPaidNow: false,
      before: { user_id: null, platform_status: 'RECEIVED', rebate_status: 'UNATTRIBUTED' },
      after: { ...i.after, platform_status: 'RECEIVED' },
      order: { ...i.order, is_presale: true, deposit_paid_at: DEPOSIT, paid_at: DEPOSIT },
    }),
  ).toMatchObject({ kind: 'call', input: { paidAt: FIRST_PAID, paidAtSource: 'observed' } });
});
