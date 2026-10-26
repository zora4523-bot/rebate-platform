// B2-11a: the default WithdrawRiskFactsReader over real rows (BR-WDR-29 ①②④⑥⑦⑧⑩; task 9.3 #2:
// windows [t − N×24 h, t] closed, ② t's +08:00 day from 00:00 to t). ⑤'s base column and ⑥'s
// received shares are judged on stub facts (service.int.test.ts) and the pure functions.
// Every test seeds first and builds the reader afterwards, so a seed error shows in the red run.
import { randomBytes } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWithdrawRiskFactsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-risk-facts.ts';
import { TIMEOUT, close, fixture, open, seedUser, type Harness } from '../apply/kit.ts';
import {
  DAY,
  T,
  ago,
  book,
  memberSubject,
  otherMember,
  seedHold,
  seedPastBinding,
  seedSelfOrders,
  seedWithdrawal,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['PENDING_REVIEW', false],
  ['APPROVED', false],
  ['PAYING', false],
  ['REJECTED', false],
  ['FAILED', false],
  ['PAID_API', true],
  ['PAID_MANUAL', true],
] as const)('[AC-B2-11a#24] ① 只有 %s 的提现单时 hasPaidWithdrawal = %s', async (status, want) => {
  const f = await fixture(h);
  await seedWithdrawal(f, { status, amountFen: 1000n, createdAt: ago(40 * DAY) });
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.hasPaidWithdrawal(h.db, memberSubject(f))).toBe(want);
});

it('[AC-B2-11a#25] ① 只有其他会员的已打款单时本会员仍是首次提现', async () => {
  const f = await fixture(h);
  const other = await seedUser(h.db, f.actor.appId);
  await seedWithdrawal(f, {
    status: 'PAID_API',
    amountFen: 1000n,
    createdAt: ago(DAY),
    userId: other,
  });
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.hasPaidWithdrawal(h.db, memberSubject(f))).toBe(false);
  expect(await facts.hasPaidWithdrawal(h.db, memberSubject(f, T, other))).toBe(true);
});

// The fixture credits the member 10000 fen (REBATE_CREDIT) at NOW = 2026-10-19 10:00 +08:00.
it.each([
  { label: '入账时刻恰为 t（闭区间）', now: '2026-10-19T02:00:00.000Z', want: true },
  { label: 't 早于入账 1 毫秒', now: '2026-10-19T01:59:59.999Z', want: false },
  { label: '同一自然日 23:59:59.999 +08:00', now: '2026-10-19T15:59:59.999Z', want: true },
  { label: '次日 00:00 +08:00', now: '2026-10-19T16:00:00.000Z', want: false },
])('[AC-B2-11a#26] ② credited_today 按 +08:00 自然日 00:00 至 t：$label', async ({ now, want }) => {
  const f = await fixture(h);
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.creditedToday(h.db, memberSubject(f, new Date(now)))).toBe(want);
});

it.each([
  {
    label: '自然日 00:00:00.000 +08:00 的 REBATE_CREDIT',
    type: 'REBATE_CREDIT',
    at: '2026-10-18T16:00:00.000Z',
    want: true,
  },
  {
    label: '前一日 23:59:59.999 +08:00 的 REBATE_CREDIT',
    type: 'REBATE_CREDIT',
    at: '2026-10-18T15:59:59.999Z',
    want: false,
  },
  { label: 'SHARE_CREDIT', type: 'SHARE_CREDIT', at: '2026-10-19T01:00:00.000Z', want: true },
  { label: 'REFERRAL_CREDIT', type: 'REFERRAL_CREDIT', at: '2026-10-19T01:00:00.000Z', want: true },
  { label: 'REWARD 不算', type: 'REWARD', at: '2026-10-19T01:00:00.000Z', want: false },
  { label: 'ADMIN_ADJUST 不算', type: 'ADMIN_ADJUST', at: '2026-10-19T01:00:00.000Z', want: false },
])('[AC-B2-11a#27] ② 分录类型与日界：$label', async ({ type, at, want }) => {
  const f = await fixture(h);
  const member = await otherMember(f);
  await book(f, member, -500n, type, new Date(at));
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.creditedToday(h.db, memberSubject(f, T, member))).toBe(want);
});

it('[AC-B2-11a#28] ② 只看本会员的分录', async () => {
  const f = await fixture(h);
  const member = await otherMember(f);
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.creditedToday(h.db, memberSubject(f, T, member))).toBe(false);
});

it('[AC-B2-11a#29] ④ 60 天窗口内、已归属、buy_type=self 的子订单；失效 = VOID / CLAWED_BACK / 维权成功', async () => {
  const f = await fixture(h);
  await seedSelfOrders(f);
  const facts = createWithdrawRiskFactsReader();
  const orders = await facts.selfOrders60d(h.db, memberSubject(f));
  expect(orders).toHaveLength(10);
  expect(orders.filter((order) => order.invalid)).toHaveLength(4);
});

it('[AC-B2-11a#30] ⑥ 分子：30 天窗口内、状态不是 REJECTED / FAILED 的本会员提现额', async () => {
  const f = await fixture(h);
  const other = await seedUser(h.db, f.actor.appId);
  const idle = await seedUser(h.db, f.actor.appId);
  const thirty = 30 * DAY;
  await seedWithdrawal(f, { status: 'PENDING_REVIEW', amountFen: 100n, createdAt: ago(DAY) });
  await seedWithdrawal(f, { status: 'APPROVED', amountFen: 200n, createdAt: ago(2 * DAY) });
  await seedWithdrawal(f, { status: 'PAYING', amountFen: 400n, createdAt: ago(3 * DAY) });
  await seedWithdrawal(f, { status: 'PAID_API', amountFen: 800n, createdAt: ago(4 * DAY) });
  await seedWithdrawal(f, { status: 'PAID_MANUAL', amountFen: 1600n, createdAt: ago(thirty) });
  // Not counted.
  await seedWithdrawal(f, { status: 'REJECTED', amountFen: 3200n, createdAt: ago(5 * DAY) });
  await seedWithdrawal(f, { status: 'FAILED', amountFen: 6400n, createdAt: ago(6 * DAY) });
  await seedWithdrawal(f, { status: 'PAID_API', amountFen: 12800n, createdAt: ago(thirty + 1) });
  await seedWithdrawal(f, {
    status: 'PAID_API',
    amountFen: 25600n,
    createdAt: ago(DAY),
    userId: other,
  });
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.withdrawn30dFen(h.db, memberSubject(f))).toBe(3100n);
  expect(await facts.withdrawn30dFen(h.db, memberSubject(f, T, idle))).toBe(0n);
});

it('[AC-B2-11a#31] ⑥ 分母：没有确认收货的子订单时为 0', async () => {
  const f = await fixture(h);
  await seedSelfOrders(f);
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.received60dFen(h.db, memberSubject(f))).toBe(0n);
});

it('[AC-B2-11a#32] ⑦ 本会员任一分录 balance_after_fen < 0 即为真，回正后仍为真；他人负余额不算', async () => {
  const f = await fixture(h);
  const positive = await otherMember(f);
  const negative = await otherMember(f);
  const recovered = await otherMember(f);
  await book(f, positive, -100n, 'REBATE_CREDIT', ago(10 * DAY));
  await book(f, negative, -100n, 'REBATE_CREDIT', ago(10 * DAY));
  await book(f, negative, 300n, 'CLAWBACK', ago(9 * DAY));
  await book(f, recovered, -100n, 'REBATE_CREDIT', ago(10 * DAY));
  await book(f, recovered, 300n, 'CLAWBACK', ago(9 * DAY));
  await book(f, recovered, -500n, 'REBATE_CREDIT', ago(8 * DAY));
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.hadNegative(h.db, memberSubject(f, T, positive))).toBe(false);
  expect(await facts.hadNegative(h.db, memberSubject(f, T, negative))).toBe(true);
  expect(await facts.hadNegative(h.db, memberSubject(f, T, recovered))).toBe(true);
  expect(await facts.hadNegative(h.db, memberSubject(f))).toBe(false);
});

it.each([
  { label: '已解除的 recon_diff', reason: 'recon_diff', released: true, mine: true, want: true },
  { label: '未解除的 recon_diff', reason: 'recon_diff', released: false, mine: true, want: true },
  { label: '已解除的 manual', reason: 'manual', released: true, mine: true, want: false },
  { label: 'ledger_mismatch', reason: 'ledger_mismatch', released: true, mine: true, want: false },
  { label: '他人的 recon_diff', reason: 'recon_diff', released: true, mine: false, want: false },
] as const)(
  '[AC-B2-11a#33] ⑧ recon_diff：$label → $want',
  async ({ reason, released, mine, want }) => {
    const f = await fixture(h);
    const userId = mine ? f.actor.userId : await seedUser(h.db, f.actor.appId);
    await seedHold(f, {
      reason,
      createdAt: ago(200 * DAY),
      releasedAt: released ? ago(150 * DAY) : null,
      userId,
    });
    const facts = createWithdrawRiskFactsReader();
    expect(await facts.reconDiff(h.db, memberSubject(f))).toBe(want);
  },
);

it.each([
  { label: '其他会员 30 天前绑定、10 天前换走', other: true, bound: 30, changed: 10, want: true },
  {
    label: '其他会员 200 天前绑定、100 天前换走（不在 90 天内）',
    other: true,
    bound: 200,
    changed: 100,
    want: false,
  },
  { label: '本人从前绑定过同一账号', other: false, bound: 30, changed: 10, want: false },
] as const)(
  '[AC-B2-11a#34] ⑩ payee_prev_other_user（支付宝）：$label',
  async ({ other, bound, changed, want }) => {
    const f = await fixture(h);
    const userId = other ? await seedUser(h.db, f.actor.appId) : f.actor.userId;
    await seedPastBinding(f, {
      userId,
      method: 'alipay',
      hmac: f.hmac,
      boundAt: ago(bound * DAY),
      changedAt: ago(changed * DAY),
    });
    const facts = createWithdrawRiskFactsReader();
    expect(await facts.payeePrevOtherUser(h.db, memberSubject(f))).toBe(want);
  },
);

it('[AC-B2-11a#35] ⑩ 银行卡同样判定；其他会员近期绑定的是别的账号不算', async () => {
  const hit = await fixture(h, { method: 'bank_card' });
  const miss = await fixture(h, { method: 'bank_card' });
  for (const [f, hmac] of [
    [hit, hit.hmac],
    [miss, randomBytes(32).toString('hex')],
  ] as const) {
    await seedPastBinding(f, {
      userId: await seedUser(h.db, f.actor.appId),
      method: 'bank_card',
      hmac,
      boundAt: ago(30 * DAY),
      changedAt: ago(10 * DAY),
    });
  }
  const facts = createWithdrawRiskFactsReader();
  expect(await facts.payeePrevOtherUser(h.db, memberSubject(hit))).toBe(true);
  expect(await facts.payeePrevOtherUser(h.db, memberSubject(miss))).toBe(false);
});
