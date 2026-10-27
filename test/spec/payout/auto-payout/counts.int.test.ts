// BR-WDR-30 ⑦ 次数 and ⑨ 全平台日累计 as the consumer counts them: withdrawals with review_mode=auto,
// status ∉ {REJECTED, FAILED} and reviewed_at in the current +08:00 day / month (this one
// included: existing + 1 ≤ max; Σ existing + amount ≤ platform_daily_max_fen); the payee by the
// snapshot payee_hmac across members, the member by user_id; only this app's rows. W1 runs first,
// the earlier withdrawals are seeded after it (W1's own BR-WDR-04 limits are not under test).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY_START,
  MONTH_START,
  TIMEOUT,
  close,
  decision,
  key,
  open,
  setup,
  type AutoFixture,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function judge(f: AutoFixture, id: string) {
  await f.consumer().consume(await f.event(id));
  return (await f.row(id)).auto_decision;
}

const EARLIER_THIS_MONTH = new Date('2026-10-03T02:00:00.000Z');

it('[AC-B2-11c#30] 08 例：会员 10 月 3 日已有 1 笔自动到账，10 月 19 日再申请 → user_monthly_count（默认每月 1 笔）', async () => {
  const f = await setup(h);
  const id = await f.start(10_000n);
  await f.seedReviewed({ userId: f.actor.userId, reviewedAt: EARLIER_THIS_MONTH });
  expect(await judge(f, id)).toEqual(decision('manual', ['user_monthly_count']));
  expect(f.execute).not.toHaveBeenCalled();
});

it('[AC-B2-11c#31] ⑦ 日界按 +08:00：reviewed_at = 当日 00:00 计入当日与当月（user_daily_count、user_monthly_count）；前一日 23:59:59.999 只计入当月', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await f.seedReviewed({ userId: f.actor.userId, reviewedAt: DAY_START });
  expect(await judge(f, id)).toEqual(
    decision('manual', ['user_daily_count', 'user_monthly_count']),
  );

  const g = await setup(h);
  const other = await g.start(100n);
  await g.seedReviewed({
    userId: g.actor.userId,
    reviewedAt: new Date(DAY_START.getTime() - 1),
  });
  expect(await judge(g, other)).toEqual(decision('manual', ['user_monthly_count']));
});

it('[AC-B2-11c#32] ⑦ 月界按 +08:00：reviewed_at = 10 月 1 日 00:00 计入当月；9 月 30 日 23:59:59.999 不计入', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await f.seedReviewed({ userId: f.actor.userId, reviewedAt: MONTH_START });
  expect(await judge(f, id)).toEqual(decision('manual', ['user_monthly_count']));

  const g = await setup(h);
  const other = await g.start(100n);
  await g.seedReviewed({
    userId: g.actor.userId,
    reviewedAt: new Date(MONTH_START.getTime() - 1),
  });
  expect(await judge(g, other)).toEqual(decision('auto', []));
});

it('[AC-B2-11c#33] ⑦ 计数对象只含 review_mode=auto 且 status ∉ {REJECTED, FAILED}：同会员当日的 REJECTED / FAILED 自动单与人工单都不计', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await f.seedReviewed({ userId: f.actor.userId, status: 'REJECTED' });
  await f.seedReviewed({ userId: f.actor.userId, status: 'FAILED' });
  await f.seedReviewed({ userId: f.actor.userId, status: 'PAID_MANUAL', reviewMode: 'manual' });
  expect(await judge(f, id)).toEqual(decision('auto', []));
});

it.each(['APPROVED', 'PAYING', 'PAID_API'] as const)(
  '[AC-B2-11c#34] ⑦ 当日 %s 的自动单计入（按 reviewed_at，不按 created_at：前一日建、当日审的也算当日）',
  async (status) => {
    const f = await setup(h);
    const id = await f.start(100n);
    await f.seedReviewed({
      userId: f.actor.userId,
      status,
      createdAt: new Date(DAY_START.getTime() - 3_600_000),
      reviewedAt: DAY_START,
    });
    expect(await judge(f, id)).toEqual(
      decision('manual', ['user_daily_count', 'user_monthly_count']),
    );
  },
);

it('[AC-B2-11c#35] ⑦ 同一收款账号按快照 payee_hmac 跨会员合计：另一会员同账号当日已自动到账 1 笔 → payee_daily_count；本会员的计数不受影响', async () => {
  const f = await setup(h);
  const other = await f.member();
  const id = await f.start(100n);
  await f.seedReviewed({ userId: other.actor.userId, payeeHmac: f.hmac });
  expect(await judge(f, id)).toEqual(decision('manual', ['payee_daily_count']));
});

it('[AC-B2-11c#36] ⑦ 同一收款账号当月（默认 2 笔）：其他会员本月同账号已有 2 笔 → payee_monthly_count；1 笔时放行', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  for (let i = 0; i < 2; i += 1) {
    const other = await f.member();
    await f.seedReviewed({
      userId: other.actor.userId,
      payeeHmac: f.hmac,
      reviewedAt: EARLIER_THIS_MONTH,
    });
  }
  expect(await judge(f, id)).toEqual(decision('manual', ['payee_monthly_count']));

  const g = await setup(h);
  const single = await g.start(100n);
  const other = await g.member();
  await g.seedReviewed({
    userId: other.actor.userId,
    payeeHmac: g.hmac,
    reviewedAt: EARLIER_THIS_MONTH,
  });
  expect(await judge(g, single)).toEqual(decision('auto', []));
});

it('[AC-B2-11c#37] ⑦ 上限 0 表示不限：user_monthly_max_count=0 时本月已有自动单仍放行', async () => {
  const f = await setup(h);
  await f.set(key('user_monthly_max_count'), 0);
  const id = await f.start(100n);
  await f.seedReviewed({ userId: f.actor.userId, reviewedAt: EARLIER_THIS_MONTH });
  expect(await judge(f, id)).toEqual(decision('auto', []));
});

it('[AC-B2-11c#38] ⑨ 全平台当日自动合计含本单：已有 190000 + 本单 10000 = 200000 放行（等号）；190001 + 10000 → platform_daily_max', async () => {
  const f = await setup(h);
  const other = await f.member();
  const id = await f.start(10_000n);
  await f.seedReviewed({ userId: other.actor.userId, amount: 190_000n });
  expect(await judge(f, id)).toEqual(decision('auto', []));

  const g = await setup(h);
  const another = await g.member();
  const over = await g.start(10_000n);
  await g.seedReviewed({ userId: another.actor.userId, amount: 190_001n });
  expect(await judge(g, over)).toEqual(decision('manual', ['platform_daily_max']));
});

it('[AC-B2-11c#39] ⑨ 只计本 app 当日、review_mode=auto、status ∉ {REJECTED, FAILED} 的单：前一日、REJECTED、FAILED、人工单与别的 app 的单都不计', async () => {
  const f = await setup(h);
  const other = await f.member();
  const id = await f.start(10_000n);
  const big = 199_000n;
  await f.seedReviewed({
    userId: other.actor.userId,
    amount: big,
    reviewedAt: new Date(DAY_START.getTime() - 1),
  });
  await f.seedReviewed({ userId: other.actor.userId, amount: big, status: 'REJECTED' });
  await f.seedReviewed({ userId: other.actor.userId, amount: big, status: 'FAILED' });
  await f.seedReviewed({ userId: other.actor.userId, amount: big, reviewMode: 'manual' });
  const elsewhere = await setup(h);
  await elsewhere.seedReviewed({ userId: elsewhere.actor.userId, amount: big });
  expect(await judge(f, id)).toEqual(decision('auto', []));
});
