// BR-WDR-30 自动路径 and 判定时点与并发 (lock order), BR-WDR-26 (manual → review_deadline):
// the consumer's two outcomes on a member that meets every default condition.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  NOW,
  TIMEOUT,
  close,
  decision,
  expectOneExecute,
  open,
  setup,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-11c#1] 08 例：已有 2 笔人工到账、本月无自动到账、无阻断标签，申请 ¥280 → auto：系统 W2（reviewer_id 空）后以 system:auto_payout 调 executeBatch 单单执行', async () => {
  const f = await setup(h);
  for (const at of ['2026-08-03T02:00:00.000Z', '2026-09-03T02:00:00.000Z']) {
    await f.seedReviewed({
      userId: f.actor.userId,
      reviewMode: 'manual',
      reviewedAt: new Date(at),
    });
  }
  const id = await f.start(28_000n);
  const consumer = f.consumer();
  await consumer.consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    status: 'APPROVED',
    review_mode: 'auto',
    reviewer_id: null,
    reviewed_at: NOW,
    blocked_reason: null,
    auto_decision: decision('auto', []),
  });
  // Exactly the five keys of BR-WDR-30 可追溯 (no execute_blocked: EXECUTE went through).
  expect((await f.row(id)).auto_decision).toEqual(decision('auto', []));
  expectOneExecute(f, id);
  expect(await f.approvals(id)).toEqual([
    {
      name: 'wallet.withdrawal_changed',
      payload: { withdrawal_id: id, user_id: f.actor.userId, status: 'APPROVED' },
    },
  ]);
  const logged = JSON.stringify(f.logger.warn.mock.calls);
  expect(logged).not.toContain(f.hmac);
  expect(logged).not.toContain('合成姓名');
});

it('[AC-B2-11c#2] 08 例：申请 ¥350 → manual，failed_conditions=[max_amount]；单据留 PENDING_REVIEW，不 W2、不执行，review_deadline = created_at + 24 个工作日小时', async () => {
  const f = await setup(h);
  const id = await f.start(35_000n);
  await f.consumer().consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    status: 'PENDING_REVIEW',
    review_mode: 'manual',
    reviewer_id: null,
    reviewed_at: null,
    // Monday 10:00 +08:00 + 24 working hours (no calendar configured: weekends only).
    review_deadline: new Date('2026-10-20T02:00:00.000Z'),
    auto_decision: decision('manual', ['max_amount']),
  });
  expect((await f.row(id)).auto_decision).toEqual(decision('manual', ['max_amount']));
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.approvals(id)).toEqual([]);
});

it('[AC-B2-11c#3] ② 边界含等号：¥300.00 auto、¥300.01 manual；max_amount_fen=0 时任何金额都转人工', async () => {
  const f = await setup(h);
  const exact = await f.start(30_000n);
  await f.consumer().consume(await f.event(exact));
  expect((await f.row(exact)).auto_decision).toEqual(decision('auto', []));

  const g = await setup(h);
  const over = await g.start(30_001n);
  await g.consumer().consume(await g.event(over));
  expect((await g.row(over)).auto_decision).toEqual(decision('manual', ['max_amount']));

  const z = await setup(h);
  await z.set('withdraw.auto_payout.max_amount_fen', 0);
  const small = await z.start(100n);
  await z.consumer().consume(await z.event(small));
  expect((await z.row(small)).auto_decision).toEqual(decision('manual', ['max_amount']));
  expect(z.execute).not.toHaveBeenCalled();
});

it('[AC-B2-11c#4] 锁顺序同 BR-WDR-07：先锁该会员 users 行，再锁其余额行', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const balances = vi.spyOn(f.ledger, 'lockBalances');
  await f.consumer().consume(await f.event(id));
  expect(f.lockUsers).toHaveBeenCalledWith(expect.anything(), {
    appId: f.appId,
    userIds: [f.actor.userId],
  });
  expect(balances).toHaveBeenCalledWith(expect.anything(), {
    appId: f.appId,
    userIds: [f.actor.userId],
  });
  expect(f.lockUsers.mock.invocationCallOrder[0]).toBeLessThan(
    balances.mock.invocationCallOrder[0]!,
  );
  expect((await f.row(id)).review_mode).toBe('auto');
});

it('[AC-B2-11c#5] 判定时刻取注入时钟：decided_at 与系统 W2 的 reviewed_at 都是判定时的 Clock，executeBatch 的 now 同一时刻', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const later = new Date(NOW.getTime() + 7 * 60_000);
  f.clock.set(later);
  await f.consumer().consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    status: 'APPROVED',
    review_mode: 'auto',
    reviewed_at: later,
    auto_decision: decision('auto', [], {}, later),
  });
  expectOneExecute(f, id, later);
});

it('[AC-B2-11c#6] 只处理事件指向的 app_id / 提现单：同 app 另一会员、另一 app 的待审单不变', async () => {
  const f = await setup(h);
  const sibling = await f.member();
  const other = await setup(h);
  const id = await f.start(100n);
  const siblingId = await f.start(100n, sibling);
  const otherId = await other.start(100n);
  const before = { sibling: await f.row(siblingId), other: await other.row(otherId) };
  await f.consumer().consume(await f.event(id));
  expect((await f.row(id)).review_mode).toBe('auto');
  expect(await f.row(siblingId)).toEqual(before.sibling);
  expect(await other.row(otherId)).toEqual(before.other);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
