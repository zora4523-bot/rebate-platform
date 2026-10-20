import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fixture,
  growth,
  openDatabase,
  ready,
  warned,
  QUALIFIED,
  EXPIRES,
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

it.each([
  { buy_type: 'share' },
  { base_fen: 0 },
  { base_fen: -1 },
  { pay_amount_fen: 999 },
  { base_fen: null },
  { pay_amount_fen: null },
])('[AC-B1-35#20] 不合格入账单 %j 不触发不作废，下一笔合格单可触发', async (patch) => {
  const f = await fixture(database);
  f.settings.set('min_paid_fen', 1000);
  await f.seedReward();
  f.clock.set(PAID);
  const { base_fen, pay_amount_fen, ...rest } = patch;
  const ignored = await f.order({
    ...rest,
    ...(base_fen === undefined ? {} : { base_fen: base_fen === null ? null : BigInt(base_fen) }),
    ...(pay_amount_fen === undefined
      ? {}
      : { pay_amount_fen: pay_amount_fen === null ? null : BigInt(pay_amount_fen) }),
  });
  await f.trigger(ignored.order_id);
  expect(await f.row()).toMatchObject({
    status: 'qualified',
    trigger_order_id: null,
    row_version: 0,
  });
  const good = await f.order({ pay_amount_fen: 1000n });
  await f.trigger(good.order_id);
  expect(await f.row()).toMatchObject({
    status: 'qualified',
    trigger_order_id: good.order_id,
    triggered_at: new Date(PAID),
    row_version: 1,
  });
  expect(await f.vouchers()).toEqual([]);
});

it.each([
  ['2026-10-20T01:59:59.999Z', false],
  [QUALIFIED, true],
  ['2026-11-19T01:59:59.999Z', true],
  [EXPIRES, false],
  ['2026-11-25T02:00:00Z', false],
] as const)(
  '[AC-B1-35#21] attr_at=%s 按锁定天数左闭右开，月结晚不缩短有效期',
  async (at, valid) => {
    const f = await fixture(database);
    await f.seedReward();
    f.settings.set('eligibility_days', 1);
    f.clock.set('2026-12-25T02:00:00Z');
    const order = await f.order({ attr_at: new Date(at) });
    await f.trigger(order.order_id);
    expect(await f.row()).toMatchObject({
      status: 'qualified',
      trigger_order_id: valid ? order.order_id : null,
      eligibility_days: 30,
      row_version: valid ? 1 : 0,
    });
    if (valid) {
      await f.process();
      expect(await f.row()).toMatchObject({ status: 'processed' });
      expect(f.grants.map((g) => g.amount_fen)).toEqual([1000n, 1000n]);
    } else {
      expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
    }
  },
);

it('[AC-B1-35#22] 同时两笔入账只记录一个触发，后续重放不改触发时刻', async () => {
  const f = await fixture(database);
  await f.seedReward();
  f.clock.set(PAID);
  const a = await f.order();
  const b = await f.order();
  await Promise.all([f.trigger(a.order_id), f.trigger(b.order_id)]);
  const winner = await f.row();
  expect([a.order_id, b.order_id]).toContain(winner?.trigger_order_id);
  expect(winner).toMatchObject({ row_version: 1, triggered_at: new Date(PAID) });
  f.clock.set('2026-11-26T02:00:00Z');
  await f.trigger(b.order_id);
  expect(await f.row()).toEqual(winner);
  expect(await f.vouchers()).toEqual([]);
});

it.each([-1, 1.1, '0', null])('[AC-B1-35#23] 最低实付坏值 %j 本单不触发、告警', async (minimum) => {
  const f = await fixture(database);
  await f.seedReward();
  f.settings.set('min_paid_fen', minimum);
  const order = await f.order();
  await f.trigger(order.order_id);
  expect(await f.row()).toMatchObject({ status: 'qualified', trigger_order_id: null });
  warned(f);
});

it('[AC-B1-35#24] 触发跟随 CREDITED 外层事务回滚，无提前发放', async () => {
  const f = await fixture(database);
  await f.seedReward();
  const order = await f.order();
  const trigger = (await growth()).createInviteRewardTrigger(f.deps);
  const abort = new Error('rollback credited');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await trigger.onCredited(trx, { app_id: f.appId, order_id: order.order_id });
      expect(
        await trx
          .selectFrom('invite_rewards')
          .select('trigger_order_id')
          .where('app_id', '=', f.appId)
          .where('invitee_id', '=', f.invitee)
          .executeTakeFirst(),
      ).toEqual({ trigger_order_id: order.order_id });
      expect(await f.vouchers()).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.row()).toMatchObject({ trigger_order_id: null, row_version: 0 });
});

it('[AC-B1-35#25] 触发端口 SQL 错误只回滚保存点，不阻塞调用事务', async () => {
  const f = await fixture(database);
  await f.seedReward();
  const order = await f.order();
  f.deps.orders.read = async (trx) => {
    await sql`select 1 / 0`.execute(trx);
    return null;
  };
  const trigger = (await growth()).createInviteRewardTrigger(f.deps);
  await f.db.transaction().execute(async (trx) => {
    await trigger.onCredited(trx, { app_id: f.appId, order_id: order.order_id });
    expect((await sql<{ n: number }>`select 1 as n`.execute(trx)).rows).toEqual([{ n: 1 }]);
  });
  expect(await f.row()).toMatchObject({ trigger_order_id: null });
  warned(f, 50);
});

it('[AC-B1-35#26] 订单属于另一个 app 或用户时不触发本人的资格', async () => {
  const f = await fixture(database);
  await f.seedReward();
  const other = await f.user();
  const order = await f.order({ user_id: other });
  await f.trigger(order.order_id);
  expect(await f.row()).toMatchObject({ trigger_order_id: null });
  const foreign = await f.order({ app_id: `other_${f.appId}` });
  await f.trigger(foreign.order_id);
  expect(await f.row()).toMatchObject({ trigger_order_id: null });
});

it('[AC-B1-35#30] 期限内无单：到期前不动、恰到期 expired 并只释放一次', async () => {
  const f = await fixture(database);
  await f.seedReward();
  f.clock.set('2026-11-19T01:59:59.999Z');
  await f.expire();
  expect(await f.row()).toMatchObject({ status: 'qualified' });
  f.clock.set(EXPIRES);
  await f.expire();
  expect(await f.row()).toMatchObject({ status: 'expired', row_version: 1 });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
  await f.expire();
  const late = await f.order({ attr_at: new Date(PAID) });
  await f.trigger(late.order_id);
  expect(await f.row()).toMatchObject({
    status: 'expired',
    trigger_order_id: null,
    row_version: 1,
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n });
  expect(await f.vouchers()).toEqual([]);
});

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B1-35#31] 期内 %s 订单等结果；后续 VOID 才过期',
  async (rebate_status) => {
    const f = await fixture(database);
    await f.seedReward();
    const pending = await f.order({ rebate_status, base_fen: null });
    f.clock.set(PAID);
    await f.expire();
    expect(await f.row()).toMatchObject({ status: 'qualified', row_version: 0 });
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n });
    pending.rebate_status = 'VOID';
    await f.expire();
    expect(await f.row()).toMatchObject({ status: 'expired' });
    expect(await f.budget()).toMatchObject({ reserved_fen: 0n });
    expect(f.reads.filter((r) => r.kind === 'window')).toContainEqual({
      kind: 'window',
      transactional: true,
      input: {
        app_id: f.appId,
        user_id: f.invitee,
        from: new Date(QUALIFIED),
        to: new Date(EXPIRES),
      },
    });
  },
);

it.each([
  { rebate_status: 'VOID' },
  { rebate_status: 'CLAWED_BACK' },
  { base_fen: 0 },
  { pay_amount_fen: 999 },
  { buy_type: 'share' },
  { attr_at: new Date(EXPIRES) },
  { attr_at: new Date('2026-10-19T02:00:00Z') },
])('[AC-B1-35#32] 只有不可触发单 %j，过期释放占用', async (patch) => {
  const f = await fixture(database);
  f.settings.set('min_paid_fen', 1000);
  await f.seedReward();
  const { base_fen, pay_amount_fen, ...rest } = patch;
  await f.order({
    ...rest,
    ...(base_fen === undefined ? {} : { base_fen: BigInt(base_fen) }),
    ...(pay_amount_fen === undefined ? {} : { pay_amount_fen: BigInt(pay_amount_fen) }),
  });
  f.clock.set(PAID);
  await f.expire();
  expect(await f.row()).toMatchObject({ status: 'expired' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
});

it('[AC-B1-35#33] 期内已入账但漏触发，过期任务补触发，不误释放', async () => {
  const f = await fixture(database);
  await f.seedReward();
  await f.order({ rebate_status: 'VOID' });
  const order = await f.order();
  f.clock.set(PAID);
  await f.expire();
  expect(await f.row()).toMatchObject({
    status: 'qualified',
    trigger_order_id: order.order_id,
    triggered_at: new Date(PAID),
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n });
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(await f.vouchers()).toHaveLength(2);
});

it.each(['qualified', 'deferred'])(
  '[AC-B1-35#34] 已记触发单的 %s 期后等待发放，不能被每日任务过期',
  async (status) => {
    const f = await fixture(database);
    await ready(f);
    await f.db
      .updateTable('invite_rewards')
      .set({ status })
      .where('app_id', '=', f.appId)
      .execute();
    const before = await f.row();
    f.deps.orders.listSelfOrdersInWindow = async () => [];
    await f.expire();
    expect(await f.row()).toEqual(before);
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n });
  },
);

it('[AC-B1-35#35] 并发过期任务不重复释放其他资格的预算', async () => {
  const f = await fixture(database);
  await f.seedReward();
  const other = await f.user(f.inviter);
  await f.seedReward({ invitee_id: other, qualified_at: new Date(PAID) });
  f.clock.set(PAID);
  await Promise.all(Array.from({ length: 6 }, () => f.expire()));
  expect(await f.row()).toMatchObject({ status: 'expired', row_version: 1 });
  expect(await f.row(other)).toMatchObject({ status: 'qualified' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
});

it('[AC-B1-35#36] 发放与过期竞争，期内有效单只发一次且不释放两遍', async () => {
  const f = await fixture(database);
  await ready(f);
  await Promise.all([f.process(), f.expire(), f.process(), f.expire()]);
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
  expect(await f.vouchers()).toHaveLength(2);
  expect(f.grants).toHaveLength(2);
});
