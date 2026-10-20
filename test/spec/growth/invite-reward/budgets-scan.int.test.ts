import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import {
  fixture,
  growth,
  openDatabase,
  ready,
  warned,
  QUALIFIED,
  PAID,
  type Database,
} from './kit.ts';

let database: Database;
beforeAll(async () => {
  database = await openDatabase();
}, 180_000);
afterAll(async () => {
  await database?.close();
});
async function scannerFixture() {
  const isolated = await openDatabase();
  onTestFinished(async () => {
    await isolated.close();
  });
  return fixture(isolated);
}

it.each([true, 'false', null, 0, {}])(
  '[AC-B1-35#60] 暂停/坏值 %j 顺延，恢复重判后发放',
  async (paused) => {
    const f = await fixture(database);
    await ready(f);
    f.settings.set('payout_paused', paused);
    await f.process();
    expect(await f.row()).toMatchObject({ status: 'deferred', triggered_at: new Date(PAID) });
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
    expect(f.grants).toEqual([]);
    if (paused !== true) warned(f);
    f.settings.set('payout_paused', false);
    await f.process();
    expect(await f.row()).toMatchObject({ status: 'processed' });
    expect(f.grants).toHaveLength(2);
  },
);

it('[AC-B1-35#61] 未注入凭证写入端口顺延并告警，补上后继续发', async () => {
  const f = await fixture(database);
  await ready(f);
  const writer = f.deps.grantWriter;
  delete f.deps.grantWriter;
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'deferred' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
  expect(f.lines.join('')).toContain('invite_reward_writer_unavailable');
  if (writer) f.deps.grantWriter = writer;
  await f.process();
  expect(f.grants).toHaveLength(2);
});

it.each([1999, '2000', -1, 1.5, null])(
  '[AC-B1-35#62] 每日预算不足或坏值 %j 顺延，次日午夜 +08 恢复',
  async (daily) => {
    const f = await fixture(database);
    await ready(f);
    f.clock.set('2026-11-25T15:59:59.999Z');
    f.settings.set('daily_budget_fen', daily);
    await f.process();
    expect(await f.row()).toMatchObject({ status: 'deferred' });
    expect(f.grants).toEqual([]);
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
    f.clock.set('2026-11-25T16:00:00.000Z');
    f.settings.set('daily_budget_fen', 2000);
    await f.process();
    expect(await f.budget('2026-11-26')).toMatchObject({ granted_fen: 2000n });
    expect((await f.budget('2026-11-25'))?.granted_fen ?? 0n).toBe(0n);
    expect(await f.row()).toMatchObject({ status: 'processed' });
  },
);

it('[AC-B1-35#63] 一方不发立即释放一份，重复顺延不重复释放，恢复只扣实发额', async () => {
  const f = await fixture(database);
  await ready(f);
  f.risks.set(f.inviter, 'frozen');
  f.settings.set('daily_budget_fen', 999);
  await f.process();
  expect(await f.row()).toMatchObject({
    status: 'deferred',
    inviter_result: 'skipped',
    inviter_skip_reason: 'risk_restricted',
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 1000n, granted_fen: 0n });
  await f.process();
  expect(await f.budget()).toMatchObject({ reserved_fen: 1000n });
  f.risks.clear();
  f.settings.set('daily_budget_fen', 1000);
  await f.process();
  expect(await f.row()).toMatchObject({
    status: 'processed',
    inviter_result: 'skipped',
    invitee_result: 'granted',
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 1000n });
  expect(await f.budget('2026-11-25')).toMatchObject({ granted_fen: 1000n });
  expect(f.grants).toHaveLength(1);
});

it('[AC-B1-35#64] 两方均不发不消耗每日预算，释放全部占用', async () => {
  const f = await fixture(database);
  await ready(f);
  f.risks.set(f.inviter, 'banned');
  f.risks.set(f.invitee, 'frozen');
  f.settings.set('daily_budget_fen', 0);
  await f.process();
  expect(await f.row()).toMatchObject({
    status: 'processed',
    inviter_result: 'skipped',
    invitee_result: 'skipped',
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
  expect((await f.budget('2026-11-25'))?.granted_fen ?? 0n).toBe(0n);
  expect(f.grants).toEqual([]);
});

it('[AC-B1-35#65] 次日补发重判：扣回使奖励永久作废', async () => {
  const f = await fixture(database);
  const order = await ready(f);
  f.settings.set('daily_budget_fen', 0);
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'deferred' });
  order.rebate_status = 'CLAWED_BACK';
  f.clock.set('2026-11-26T02:00:00Z');
  f.settings.set('daily_budget_fen', 2000);
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'voided', void_reason: 'order_clawed_back' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
});

it('[AC-B1-35#66] 不同邀请人真实 PG 并发争抢最后 2000 当日预算，只发一对', async () => {
  const f = await fixture(database);
  await ready(f);
  f.settings.set('daily_budget_fen', 2000);
  const parent = await f.user();
  const child = await f.user(parent);
  const order = await f.order({ user_id: child });
  await f.seedReward({
    invitee_id: child,
    inviter_id: parent,
    trigger_order_id: order.order_id,
    triggered_at: new Date(PAID),
  });
  await Promise.all([f.process(), f.process(child)]);
  expect([(await f.row())?.status, (await f.row(child))?.status].sort()).toEqual([
    'deferred',
    'processed',
  ]);
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 2000n });
  expect(await f.budget('2026-11-25')).toMatchObject({ granted_fen: 2000n });
  expect(f.grants).toHaveLength(2);
  expect(await f.vouchers()).toHaveLength(2);
});

it('[AC-B1-35#67] 扫描按触发顺序补发，预算顺延即停，下一日继续', async () => {
  const f = await scannerFixture();
  const g = await growth();
  const laterOrder = await f.order();
  await f.seedReward({
    trigger_order_id: laterOrder.order_id,
    triggered_at: new Date('2026-11-25T02:00:01Z'),
  });
  const earlier = await f.user(f.inviter);
  const earlierOrder = await f.order({ user_id: earlier });
  await f.seedReward({
    invitee_id: earlier,
    status: 'deferred',
    trigger_order_id: earlierOrder.order_id,
    triggered_at: new Date(PAID),
  });
  f.settings.set('daily_budget_fen', 2000);
  f.clock.set('2026-11-25T03:00:00Z');
  const scanned: string[] = [];
  const payout = g.createInviteRewardPayout(f.deps);
  const scanner = g.createInviteRewardScanner({
    ...f.deps,
    expiry: g.createInviteRewardExpiry(f.deps),
    payout: {
      process: async (app, id) => {
        scanned.push(id);
        return payout.process(app, id);
      },
    },
  });
  await scanner.tick();
  expect(scanned).toEqual([earlier, f.invitee]);
  expect(await f.row(earlier)).toMatchObject({ status: 'processed' });
  expect(await f.row()).toMatchObject({ status: 'deferred' });
  f.clock.set('2026-11-25T16:00:00Z');
  await scanner.tick();
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 4000n });
});

it('[AC-B1-35#68] 每日过期首轮即跑，同 +08 日不重扫，跨午夜再按取得资格时刻扫描', async () => {
  const f = await scannerFixture();
  await f.seedReward({ qualified_at: new Date(QUALIFIED) });
  const newer = await f.user(f.inviter);
  await f.seedReward({ invitee_id: newer, qualified_at: new Date('2026-10-21T02:00:00Z') });
  f.clock.set('2026-11-25T15:59:00Z');
  const seen: string[] = [];
  const scanner = (await growth()).createInviteRewardScanner({
    ...f.deps,
    payout: { process: async () => 'ignored' },
    expiry: {
      expireIfDue: async (app, id) => {
        expect(app).toBe(f.appId);
        seen.push(id);
      },
    },
  });
  await scanner.tick();
  expect(seen).toEqual([f.invitee, newer]);
  f.clock.set('2026-11-25T15:59:59.999Z');
  await scanner.tick();
  expect(seen).toEqual([f.invitee, newer]);
  f.clock.set('2026-11-25T16:00:00Z');
  await scanner.tick();
  expect(seen).toEqual([f.invitee, newer, f.invitee, newer]);
});

it('[AC-B1-35#67] 首条预算顺延即停，不跳过它发放更晚且只有一方可领的奖励', async () => {
  const f = await scannerFixture();
  await ready(f);
  const later = await f.user(f.inviter);
  const order = await f.order({ user_id: later });
  await f.seedReward({
    invitee_id: later,
    trigger_order_id: order.order_id,
    triggered_at: new Date('2026-11-25T02:00:01Z'),
  });
  f.risks.set(later, 'frozen');
  f.settings.set('daily_budget_fen', 1000);
  const laterBefore = await f.row(later);
  const g = await growth();
  const payout = g.createInviteRewardPayout(f.deps);
  const scanned: string[] = [];
  const scanner = g.createInviteRewardScanner({
    ...f.deps,
    expiry: g.createInviteRewardExpiry(f.deps),
    payout: {
      process: async (app, id) => {
        scanned.push(id);
        return payout.process(app, id);
      },
    },
  });
  await scanner.tick();
  expect(scanned).toEqual([f.invitee]);
  expect(await f.row()).toMatchObject({ status: 'deferred' });
  expect(await f.row(later)).toEqual(laterBefore);
  expect(f.grants).toEqual([]);
  expect(await f.budget()).toMatchObject({ reserved_fen: 4000n, granted_fen: 0n });
  expect((await f.budget('2026-11-25'))?.granted_fen ?? 0n).toBe(0n);
});

it('[AC-B1-35#69] 两个扫描器并发不重复发放或释放', async () => {
  const f = await scannerFixture();
  await ready(f);
  const expired = await f.user(f.inviter);
  await f.seedReward({ invitee_id: expired });
  const g = await growth();
  const deps = {
    ...f.deps,
    payout: g.createInviteRewardPayout(f.deps),
    expiry: g.createInviteRewardExpiry(f.deps),
  };
  await Promise.all([
    g.createInviteRewardScanner(deps).tick(),
    g.createInviteRewardScanner(deps).tick(),
  ]);
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(await f.row(expired)).toMatchObject({ status: 'expired' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
  expect(f.grants).toHaveLength(2);
});
