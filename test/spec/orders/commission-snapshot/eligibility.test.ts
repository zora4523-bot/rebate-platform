import { expect, it } from 'vitest';
import { planCommissionSnapshot } from '../../../../apps/api/src/modules/orders/index.ts';
import { DEPOSIT, input } from './plan-kit.ts';

it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B1-08k#1] 首次入库已归因 %s 同次生成快照',
  (platform_status) => {
    const i = input();
    expect(planCommissionSnapshot({ ...i, after: { ...i.after, platform_status } })).toMatchObject({
      kind: 'call',
    });
  },
);

it.each(['DEPOSIT_PAID', 'INVALID'] as const)(
  '[AC-B1-08k#2] 首次入库 %s 即使已归因也跳过',
  (platform_status) => {
    const i = input();
    expect(planCommissionSnapshot({ ...i, after: { ...i.after, platform_status } })).toEqual({
      kind: 'skip',
    });
  },
);

it('[AC-B1-08k#3] 首次未归因不生成；同步 R3a 归属成功的 PAID 才生成', () => {
  const i = input();
  expect(planCommissionSnapshot({ ...i, after: { ...i.after, user_id: null } })).toEqual({
    kind: 'skip',
  });
  expect(
    planCommissionSnapshot({
      ...i,
      before: { user_id: null, platform_status: 'PAID', rebate_status: 'UNATTRIBUTED' },
    }),
  ).toMatchObject({ kind: 'call' });
});

it('[AC-B1-08k#4] 定金 R3a 不生成，已归因定金付尾款 P2 才生成', () => {
  const i = input();
  const order = { ...i.order, is_presale: true, deposit_paid_at: DEPOSIT };
  expect(
    planCommissionSnapshot({
      ...i,
      order,
      before: { user_id: null, platform_status: 'DEPOSIT_PAID', rebate_status: 'UNATTRIBUTED' },
      after: { ...i.after, platform_status: 'DEPOSIT_PAID' },
    }),
  ).toEqual({ kind: 'skip' });
  expect(
    planCommissionSnapshot({
      ...i,
      order,
      before: { user_id: 'owner-A', platform_status: 'DEPOSIT_PAID', rebate_status: 'ESTIMATED' },
    }),
  ).toMatchObject({ kind: 'call' });
});

it.each(['VOID', 'CLAWED_BACK'])(
  '[AC-B1-08k#5] %s 归属成功仍不生成（R3b / 终态）',
  (rebate_status_before) => {
    const i = input();
    expect(
      planCommissionSnapshot({
        ...i,
        before: { user_id: null, platform_status: 'PAID', rebate_status: rebate_status_before },
        after: { ...i.after, rebate_status_before },
      }),
    ).toEqual({ kind: 'skip' });
  },
);

it.each(['PAID', 'RECEIVED', 'SETTLED'] as const)(
  '[AC-B1-08k#6] 已跨入资格的 %s 再更新或重放不重建',
  (platform_status) => {
    const i = input();
    expect(
      planCommissionSnapshot({
        ...i,
        before: { user_id: 'owner-A', platform_status, rebate_status: 'ESTIMATED' },
        after: { ...i.after, platform_status: 'SETTLED' },
      }),
    ).toEqual({ kind: 'skip' });
  },
);

it('[AC-B1-08k#7] 跳过资格时不因缺金额或淘礼金进入 pending', () => {
  const i = input();
  expect(
    planCommissionSnapshot({
      ...i,
      pidScene: 'taolijin',
      after: { ...i.after, user_id: null },
      order: { ...i.order, est_commission_fen: null },
    }),
  ).toEqual({ kind: 'skip' });
});
