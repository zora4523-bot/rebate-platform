import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Global setup supplies the migrated template; this file clones it and queries as couli_app.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);
import { randomUUID } from 'node:crypto';
import { at, expectAlert, expectSafeLogs, scenario } from './kit.ts';

it.each([
  { rebate: 'UNATTRIBUTED', locked: false },
  { rebate: 'UNATTRIBUTED', locked: true },
  { rebate: 'VOID', locked: false },
  { rebate: 'VOID', locked: true },
])(
  '[AC-B1-08i#33] $rebate 重跑归属成功，locked=$locked 决定能否写 user_id',
  async ({ rebate, locked }) => {
    const f = await scenario(db, {}, { unattributed: true });
    // A separate connection simulates settlement owning the rebate status.
    const settlementDb = createDb({ connectionString: database!.urlFor('couli_app'), max: 1 });
    try {
      await settlementDb
        .updateTable('orders')
        .set({ rebate_status: rebate, locked })
        .where('app_id', '=', f.ctx.app_id)
        .where('order_id', '=', f.original.order_id)
        .where('attr_at', '=', f.original.attr_at)
        .execute();
    } finally {
      await destroyDb(settlementDb);
    }
    expect((await f.read()).orders[0]).toMatchObject({
      rebate_status: rebate,
      user_id: null,
      user_basis: null,
      locked,
    });
    f.findUser.mockResolvedValue(f.userId);
    await f.pipeline.process(
      f.next({ promotion_slot: 'changed-pid', est_commission_fen: 456n }),
      f.ctx,
    );
    const after = await f.read();
    expect(after.orders[0]).toMatchObject({
      user_id: locked ? null : f.userId,
      user_basis: locked ? null : 'param',
      rebate_status: rebate,
      locked,
      pid: 'changed-pid',
      attr_at: f.original.attr_at,
      buy_type: f.original.buy_type,
      scene_basis: f.original.scene_basis,
    });
    expect(after.counters).toEqual(f.before.counters);
    expect(after.history).toEqual(f.before.history);
    const updates = f.queries.filter((q) => /^update "app"."orders"/i.test(q.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql.split(' where ')[0]).not.toMatch(/"rebate_status"\s*=/i);
    expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ attributed_now: !locked });
    expect(f.publishedOf('order.updated')[0]?.[1]).toMatchObject({
      payload: { attributed_now: !locked },
    });
    if (!locked) {
      expect(f.findUser).toHaveBeenCalledWith({ appId: f.ctx.app_id, attrCode: 'abcd1234' });
      const where =
        f.queries.find((q) => /^update "app"."orders"/i.test(q.sql))?.sql.split(' where ')[1] ?? '';
      expect(where).toMatch(/"user_id" is null/i);
      expect(where).toContain('"locked"');
    }
  },
);

it('[AC-B1-08i#34] 已归属订单不查用户、不覆盖四项参数，只告警 P2', async () => {
  const f = await scenario(db);
  await f.pipeline.process(
    f.next({
      promotion_slot: 'private-pid',
      attr_params: {
        relation_id: 'private-relation',
        sub_union_id: 'private-sub',
        custom_parameters: 'private-buyer',
      },
    }),
    f.ctx,
  );
  const row = (await f.read()).orders[0];
  expect(row).toMatchObject({
    user_id: f.userId,
    pid: f.original.pid,
    relation_id: f.original.relation_id,
    sub_union_id: f.original.sub_union_id,
    custom_params: f.original.custom_params,
    row_version: f.original.row_version + 1,
  });
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.findBindings).not.toHaveBeenCalled();
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      alert: 'P2',
      event: 'order_attr_param_changed',
      app_id: f.ctx.app_id,
      platform: 'pdd',
    }),
    expect.any(String),
  );
  expect(f.publishedOf('order.updated')).toHaveLength(1);
  expectAlert(f, 'order.attr_param_changed', {}, [
    'private-pid',
    'private-relation',
    'private-sub',
    'private-buyer',
  ]);
  expect(f.publishedOf('order.attr_param_changed')[0]?.[0]).toBe(
    f.publishedOf('order.updated')[0]?.[0],
  );
  expectSafeLogs(f);
});

it('[AC-B1-08i#35] 未归因失败可写新参数但不重复计数', async () => {
  const f = await scenario(db, {}, { unattributed: true });
  await f.pipeline.process(
    f.next({
      promotion_slot: 'new-pid',
      attr_params: {
        relation_id: 'new-relation',
        sub_union_id: 'new-sub',
        custom_parameters: 'invalid-json',
      },
    }),
    f.ctx,
  );
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({
    user_id: null,
    user_basis: null,
    pid: 'new-pid',
    relation_id: 'new-relation',
    sub_union_id: 'new-sub',
    custom_params: 'invalid-json',
  });
  expect(after.counters).toEqual(f.before.counters);
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ attributed_now: false });
});

it('[AC-B1-08i#36] 淘宝重跑仍用首次 attr_at，不能使用后来 paid_at 或同步时间', async () => {
  const f = await scenario(db, {
    platform: 'taobao',
    attr_params: {
      relation_id: 'synthetic-relation',
      sub_union_id: null,
      custom_parameters: null,
    },
  });
  f.findBindings.mockResolvedValue([
    {
      user_id: f.userId,
      bound_at: at('2026-10-14T05:06:07Z'),
      released_at: at('2026-10-16T01:02:03Z'),
      cooldown_until: null,
    },
  ]);
  await f.pipeline.process(f.next({ paid_at: at('2026-10-17T02:03:04Z') }), f.ctx);
  expect((await f.read()).orders[0]).toMatchObject({
    user_id: f.userId,
    user_basis: 'param',
    attr_at: f.original.attr_at,
  });
  expect(f.findBindings).toHaveBeenCalledWith({
    appId: f.ctx.app_id,
    unionAccountId: f.ctx.union_account_id,
    relationId: 'synthetic-relation',
  });
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ attributed_now: true });
});

it('[AC-B1-08i#37] 淘宝多用户绑定冲突不归属、告警、不重复计数', async () => {
  const f = await scenario(db, {
    platform: 'taobao',
    attr_params: {
      relation_id: 'synthetic-relation',
      sub_union_id: null,
      custom_parameters: null,
    },
  });
  const secondUser = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: secondUser,
      app_id: f.ctx.app_id,
      nickname: 'synthetic-second',
      avatar: '',
      invite_code: 'inv67890',
      attr_code: 'zzzz9999',
      level: 'member',
      register_method: 'synthetic',
      created_at: at('2026-09-05T06:07:08Z'),
      updated_at: at('2026-09-06T07:08:09Z'),
    })
    .execute();
  f.findBindings.mockResolvedValue([
    {
      user_id: f.userId,
      bound_at: at('2026-10-13T06:07:08Z'),
      released_at: null,
      cooldown_until: null,
    },
    {
      user_id: secondUser,
      bound_at: at('2026-10-14T07:08:09Z'),
      released_at: null,
      cooldown_until: null,
    },
  ]);
  await f.pipeline.process(f.next({ est_commission_fen: 321n }), f.ctx);
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({ user_id: null, est_commission_fen: 321n });
  expect(after.counters).toEqual(f.before.counters);
  expect(f.logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'attr_binding_conflict',
      alert: expect.any(String),
      app_id: f.ctx.app_id,
    }),
    expect.any(String),
  );
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ attributed_now: false });
  expectAlert(f, 'order.attr_binding_conflict', {}, [f.userId, secondUser]);
  expect(f.publishedOf('order.attr_binding_conflict')[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
});
