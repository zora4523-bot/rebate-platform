import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, fixture, pipeline, snapshot, traceQueries } from './kit.ts';

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

it('[AC-B1-08h#55] 同 App 多账号同推广位按账号独立取白名单与同步起点', async () => {
  const f = await fixture(db);
  const secondAccount = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: secondAccount,
      app_id: f.ctx.app_id,
      platform: 'pdd',
      account_name: 'second-synthetic',
      status: 'active',
      auth_status: 'active',
      sync_start_at: at('2026-10-16T06:07:08.000Z'),
      created_at: at('2026-09-20T07:08:09.000Z'),
      updated_at: at('2026-09-21T08:09:10.000Z'),
    })
    .execute();
  f.findPid.mockImplementation(async ({ appId, platform, unionAccountId, pid }) => {
    if (appId !== f.ctx.app_id || platform !== 'pdd' || pid !== 'slot-ours') return [];
    if (unionAccountId === f.ctx.union_account_id)
      return [{ status: 'retired', pid_scene: 'share', site_id: null }];
    if (unionAccountId === secondAccount)
      return [{ status: 'pending', pid_scene: 'agent', site_id: null }];
    return [];
  });
  f.syncStartAt.mockImplementation(async ({ appId, unionAccountId }) => {
    const account = await db
      .selectFrom('union_accounts')
      .select('sync_start_at')
      .where('app_id', '=', appId)
      .where('id', '=', unionAccountId)
      .executeTakeFirst();
    return account?.sync_start_at ?? null;
  });
  const trace = traceQueries(db);
  const p = await pipeline({ ...f.deps, db: trace.db });
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const secondOrder = { ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-second` };
  expect(await p.process(secondOrder, { ...f.ctx, union_account_id: secondAccount })).toMatchObject(
    { kind: 'dropped', reason: 'BEFORE_SYNC_START' },
  );
  expect(
    await p.process(
      { ...secondOrder, paid_at: at('2026-10-17T09:10:11.000Z') },
      { ...f.ctx, union_account_id: secondAccount },
    ),
  ).toMatchObject({ kind: 'inserted' });
  const saved = await snapshot(db, f.ctx.app_id);
  expect(saved.orders.map((r) => [r.sub_order_id, r.buy_type])).toEqual([
    [f.incoming.sub_order_id, 'share'],
    [secondOrder.sub_order_id, 'self'],
  ]);
  // Access to other modules must go through the supplied ports. Their fixture queries
  // use the untraced handle; direct pipeline reads of these tables are forbidden.
  expect(
    trace.queries.filter((q) => /\b(union_pids|union_accounts|union_bindings|users)\b/.test(q.sql)),
  ).toEqual([]);
});

it('[AC-B1-08h#56] 相同子订单号跨平台可分别建键，不能只按 sub_order_id 去重', async () => {
  const f = await fixture(db);
  const second = await fixture(db, {
    platform: 'jd',
    sub_order_id: f.incoming.sub_order_id!,
    attr_params: { relation_id: null, custom_parameters: null, sub_union_id: 'n_abcd1234' },
  });
  const p = await pipeline(f.deps);
  const q = await pipeline(second.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect(await q.process(second.incoming, second.ctx)).toMatchObject({ kind: 'inserted' });
  const a = await snapshot(db, f.ctx.app_id);
  const b = await snapshot(db, second.ctx.app_id);
  expect(a.keys).toHaveLength(1);
  expect(b.keys).toHaveLength(1);
  expect(a.keys[0]?.order_id).not.toBe(b.keys[0]?.order_id);
  expect(b.orders[0]).toMatchObject({ platform: 'jd', user_id: second.userId });
});

it.each([
  {
    goods_id: 'goods',
    goods_sign: 'sign',
    item_id: 'item',
    itemId: 'camel',
    skuId: 'sku',
    expected: 'goods',
  },
  {
    goods_id: null,
    goods_sign: 'sign',
    item_id: 'item',
    itemId: 'camel',
    skuId: 'sku',
    expected: 'sign',
  },
  {
    goods_id: null,
    goods_sign: null,
    item_id: 'item',
    itemId: 'camel',
    skuId: 'sku',
    expected: 'item',
  },
  {
    goods_id: null,
    goods_sign: null,
    item_id: null,
    itemId: 'camel',
    skuId: 'sku',
    expected: 'camel',
  },
  { goods_id: null, goods_sign: null, item_id: null, itemId: null, skuId: 'sku', expected: 'sku' },
  { goods_id: null, goods_sign: null, item_id: null, itemId: null, skuId: null, expected: '' },
])(
  '[AC-B1-08h#57] raw_item_id 按约定回退为 $expected，金额分值不经浮点',
  async ({ expected, ...ids }) => {
    const f = await fixture(db, { ...ids, paid_fen: 9007199254740993n, est_commission_fen: -1n });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const saved = await snapshot(db, f.ctx.app_id);
    expect(saved.orders[0]).toMatchObject({
      raw_item_id: expected,
      product_key: null,
      pay_amount_fen: 9007199254740993n,
      est_commission_fen: -1n,
    });
    if (expected === '') expect(f.logger.warn).toHaveBeenCalled();
  },
);

it('[AC-B1-08h#58] 淘宝绑定端口按 app、账号、relation 隔离；过期行不归属', async () => {
  const f = await fixture(db, {
    platform: 'taobao',
    attr_params: { relation_id: 'relation-only', sub_union_id: null, custom_parameters: null },
  });
  f.findBindings.mockImplementation(async ({ appId, unionAccountId, relationId }) => {
    if (
      appId !== f.ctx.app_id ||
      unionAccountId !== f.ctx.union_account_id ||
      relationId !== 'relation-only'
    ) {
      return [
        {
          user_id: f.userId,
          bound_at: at('2026-10-10T01:02:03.000Z'),
          released_at: null,
          cooldown_until: null,
        },
      ];
    }
    return [
      {
        user_id: f.userId,
        bound_at: at('2026-10-11T02:03:04.000Z'),
        released_at: f.incoming.paid_at!,
        cooldown_until: null,
      },
      { user_id: f.userId, bound_at: null, released_at: null, cooldown_until: null },
    ];
  });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders[0]).toMatchObject({ user_id: null, user_basis: null });
  expect(s.counters).toEqual([
    expect.objectContaining({ counter: 'attr_binding_miss', count: 1n }),
  ]);
});
