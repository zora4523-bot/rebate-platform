import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { fixture, growth, openDatabase, warned, QUALIFIED, type Database } from './kit.ts';

let database: Database;
beforeAll(async () => {
  database = await openDatabase();
}, 180_000);
afterAll(async () => {
  await database?.close();
});

it.each(['register', 'landing', 'backfill'] as const)(
  '[AC-B1-35#1] %s 锁定金额、有效期、绑定时刻、IP 摘要并占用两份预算，重放不变',
  async (bind_source) => {
    const f = await fixture(database);
    await f.qualify({ bind_source, client_ip: '2001:0db8:0:0:0:0:0:1/128' });
    // inet accepts masks, but net.isIP does not: malformed input must not acquire eligibility.
    expect(await f.row()).toBeUndefined();
    await f.qualify({ bind_source, client_ip: '2001:0db8:0:0:0:0:0:1' });
    expect(await f.row()).toMatchObject({
      status: 'qualified',
      amount_fen: 1000n,
      eligibility_days: 30,
      bind_source,
      inviter_id: f.inviter,
      qualified_at: new Date(QUALIFIED),
      bind_ip_hmac: f.crypto.blindIndex('2001:db8::1', 'invite_rewards.bind_ip'),
    });
    expect((await f.row())?.bind_ip_hmac).toMatch(/^[0-9a-f]{64}$/);
    const original = await f.row();
    f.settings.set('amount_fen', 1700);
    f.settings.set('eligibility_days', 1);
    f.settings.set('enabled', false);
    await f.qualify();
    expect(await f.row()).toEqual(original);
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  },
);

it('[AC-B1-35#2] admin 不取得资格，随后自助绑定能取得资格', async () => {
  const f = await fixture(database);
  await f.qualify({ bind_source: 'admin' });
  expect(await f.row()).toBeUndefined();
  expect(await f.budget()).toBeUndefined();
  await f.qualify();
  expect(await f.row()).toMatchObject({ status: 'qualified' });
});

it.each([undefined, false, 'true', 'on', 1, {}, null])(
  '[AC-B1-35#3] enabled=%j 不是严格 JSON true，不写资格、不占用',
  async (enabled) => {
    const f = await fixture(database);
    f.settings.set('enabled', enabled);
    await f.qualify();
    expect(await f.row()).toBeUndefined();
    expect(await f.budget()).toBeUndefined();
  },
);

it.each([1999, 2000])('[AC-B1-35#4] 可用总预算 %i 的原子边界', async (total) => {
  const f = await fixture(database);
  f.settings.set('total_budget_fen', total + 300);
  await f.db
    .insertInto('invite_reward_budgets')
    .values({
      app_id: f.appId,
      period: 'total',
      granted_fen: 300n,
    })
    .execute();
  await f.qualify();
  expect(Boolean(await f.row())).toBe(total === 2000);
  expect(await f.budget()).toMatchObject({
    granted_fen: 300n,
    reserved_fen: total === 2000 ? 2000n : 0n,
  });
});

it('[AC-B1-35#5] 金额零不写；正整数最大边界用整数分占用', async () => {
  const f = await fixture(database);
  f.settings.set('amount_fen', 0);
  await f.qualify();
  expect(await f.row()).toBeUndefined();
  f.settings.set('amount_fen', 2147483647);
  f.settings.set('total_budget_fen', 4294967294);
  await f.qualify();
  expect(await f.row()).toMatchObject({ amount_fen: 2147483647n });
  expect(await f.budget()).toMatchObject({ reserved_fen: 4294967294n });
});

it.each([-1, 1.5, '1000', 2147483648, null])(
  '[AC-B1-35#6] 金额坏值 %j 回落 1000 并告警',
  async (amount) => {
    const f = await fixture(database);
    f.settings.set('amount_fen', amount);
    await f.qualify();
    expect(await f.row()).toMatchObject({ amount_fen: 1000n });
    expect(await f.budget()).toMatchObject({ reserved_fen: 2000n });
    warned(f);
  },
);

it.each([0, -1, 3651, 1.5, '30', null])(
  '[AC-B1-35#7] 有效期坏值 %j 显式回落 30 并告警',
  async (days) => {
    const f = await fixture(database);
    f.settings.set('eligibility_days', days);
    await f.qualify();
    expect(await f.row()).toMatchObject({ eligibility_days: 30 });
    warned(f);
  },
);

it.each([1, 3650])('[AC-B1-35#8] 有效期合法边界 %i 原样锁定', async (days) => {
  const f = await fixture(database);
  f.settings.set('eligibility_days', days);
  await f.qualify();
  expect(await f.row()).toMatchObject({ eligibility_days: days });
});

it.each([-1, '2000', 2000.5, null])('[AC-B1-35#9] 总预算坏值 %j 不写并告警', async (total) => {
  const f = await fixture(database);
  f.settings.set('total_budget_fen', total);
  await f.qualify();
  expect(await f.row()).toBeUndefined();
  expect(await f.budget()).toBeUndefined();
  warned(f);
});

it('[AC-B1-35#10] 真实 PG 并发抢最后一份总预算且同邀请人不超占', async () => {
  const f = await fixture(database);
  f.settings.set('total_budget_fen', 2000);
  const ids = await Promise.all(Array.from({ length: 6 }, () => f.user(f.inviter)));
  await Promise.all(ids.map((invitee_id) => f.qualify({ invitee_id })));
  const rows = await f.db
    .selectFrom('invite_rewards')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  expect(rows).toHaveLength(1);
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
});

it('[AC-B1-35#11] 同被邀请人并发资格只占一次，不够时回滚资格但调用事务仍可用', async () => {
  const f = await fixture(database);
  await Promise.all(Array.from({ length: 6 }, () => f.qualify()));
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n });
  f.settings.set('total_budget_fen', 2000);
  const id = await f.user(f.inviter);
  const qualifier = (await growth()).createInviteRewardQualifier(f.deps);
  await f.db.transaction().execute(async (trx) => {
    await qualifier.qualifyInviteReward(trx, { ...f.qualifyInput, invitee_id: id });
    expect((await sql<{ n: number }>`select 1 as n`.execute(trx)).rows).toEqual([{ n: 1 }]);
  });
  expect(await f.row(id)).toBeUndefined();
});

it('[AC-B1-35#12] 资格与预算跟随外层绑定事务回滚', async () => {
  const f = await fixture(database);
  const qualifier = (await growth()).createInviteRewardQualifier(f.deps);
  const abort = new Error('fixture rollback');
  await expect(
    f.db.transaction().execute(async (trx) => {
      await qualifier.qualifyInviteReward(trx, f.qualifyInput);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.row()).toBeUndefined();
  expect(await f.budget()).toBeUndefined();
});

it('[AC-B1-35#13] SQL 出错回滚保存点、记录 error，外层事务仍可提交', async () => {
  const f = await fixture(database);
  f.deps.config = {
    configValue: async (_app, _key, trx) => {
      await sql`select 1 / 0`.execute(trx);
      return null;
    },
  };
  const qualifier = (await growth()).createInviteRewardQualifier(f.deps);
  await f.db.transaction().execute(async (trx) => {
    await qualifier.qualifyInviteReward(trx, f.qualifyInput);
    await trx
      .updateTable('users')
      .set({ nickname: 'binding survived' })
      .where('app_id', '=', f.appId)
      .where('id', '=', f.invitee)
      .execute();
  });
  expect(await f.row()).toBeUndefined();
  expect(await f.budget()).toBeUndefined();
  expect(
    await f.db
      .selectFrom('users')
      .select('nickname')
      .where('app_id', '=', f.appId)
      .where('id', '=', f.invitee)
      .executeTakeFirst(),
  ).toEqual({ nickname: 'binding survived' });
  warned(f, 50);
});

it('[AC-B1-35#14] 可用额扣除占用与已发、无行按零占用、配置坏值 null、下限零', async () => {
  const f = await fixture(database);
  const reader = (await growth()).createInviteRewardBudgetReader(f.deps);
  expect(await reader.available(f.appId)).toBe(100000);
  await f.seedReward();
  await f.db
    .updateTable('invite_reward_budgets')
    .set({ granted_fen: 3000n })
    .where('app_id', '=', f.appId)
    .execute();
  expect(await reader.available(f.appId)).toBe(95000);
  f.settings.set('total_budget_fen', 1000);
  expect(await reader.available(f.appId)).toBe(0);
  f.settings.set('total_budget_fen', '100000');
  expect(await reader.available(f.appId)).toBeNull();
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 3000n });
});
