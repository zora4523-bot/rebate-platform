import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  business,
  capture,
  EMPTY_SOURCE,
  expectPrivateLogs,
  expectSourceWrite,
  expectWindow,
  fresh,
  runFresh,
} from './db-kit.ts';
import { at, NONE } from './kit.ts';

// Global setup supplies the migrated template; clone it and query through couli_app.
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

it('[AC-B1-08j#26] 首次归属的四列随 INSERT 写入，金额与身份不受回填影响', async () => {
  const f = await fresh(db);
  const visible: unknown[] = [];
  f.onImported.mockImplementation(async (trx, imported) => {
    visible.push(
      await trx
        .withSchema('app')
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', imported.app_id)
        .where('order_id', '=', imported.order_id)
        .executeTakeFirst(),
    );
  });
  const before = await f.read();
  const observations: unknown[] = [];
  const writesBeforeMatch: string[] = [];
  f.sources.linkLogs.mockImplementation(async () => {
    writesBeforeMatch.push(
      ...f.queries
        .filter((q) => /^(insert into|update) "app"\."(orders|order_keys)"/i.test(q.sql))
        .map((q) => q.sql),
    );
    observations.push(await f.read());
    return [f.sources.row];
  });
  expect(await runFresh(f)).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  const row = (await f.read()).orders[0]!;
  expect(row).toMatchObject(f.sources.expected);
  expect(visible).toEqual([expect.objectContaining(f.sources.expected)]);
  expect(observations).toEqual([before]);
  expect(writesBeforeMatch).toEqual([]);
  expectWindow(f, f.sources);
  expect(f.sources.productKey).toHaveBeenCalledExactlyOnceWith({
    platform: 'pdd',
    order: f.incoming,
  });
  expectSourceWrite(f.queries, 'insert');
  expectPrivateLogs(f);
  const control = await fresh(db);
  expect(
    await capture(() => createOrderPipeline(control.deps).process(control.incoming, control.ctx)),
  ).toMatchObject({ ok: true });
  const controlRow = (await control.read()).orders[0]!;
  expect(business(row)).toEqual({ ...business(controlRow), user_id: f.userId });
  expect(row).toMatchObject({
    user_id: f.userId,
    buy_type: 'share',
    user_basis: 'param',
    scene_basis: 'pid',
    pay_amount_fen: 12345n,
    est_commission_fen: 789n,
    product_key: null,
    shop_id: null,
  });
});

it.each(['unattributed', 'no-sources'] as const)(
  '[AC-B1-08j#27] %s 四列保持 NULL，成功对照仍回填',
  async (condition) => {
    const positive = await fresh(db);
    expect(await runFresh(positive)).toMatchObject({ ok: true });
    expect((await positive.read()).orders[0]).toMatchObject(positive.sources.expected);
    const f = await fresh(db);
    if (condition === 'unattributed') f.findUser.mockResolvedValue(null);
    const result =
      condition === 'no-sources'
        ? await capture(() => createOrderPipeline(f.deps).process(f.incoming, f.ctx))
        : await runFresh(f);
    expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...EMPTY_SOURCE,
      user_id: condition === 'unattributed' ? null : f.userId,
    });
    expect(f.sources.linkLogs).not.toHaveBeenCalled();
    expect(f.sources.productKey).not.toHaveBeenCalled();
    expect(f.sources.linkByCode).not.toHaveBeenCalled();
  },
);

it('[AC-B1-08j#28] 首次入库 shopId 固定为空，商品推不出则 none 而非 NULL', async () => {
  const f = await fresh(db);
  f.sources.productKey.mockResolvedValue(null);
  expect(await runFresh(f)).toMatchObject({ ok: true });
  expect((await f.read()).orders[0]).toMatchObject({ ...NONE, user_id: f.userId, shop_id: null });
  expectWindow(f, f.sources);
  expectSourceWrite(f.queries, 'insert');
});

it('[AC-B1-08j#29] 首次归属 exact 开关开启时把 link 来源写入四列', async () => {
  const f = await fresh(db);
  f.incoming = {
    ...f.incoming,
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
    },
  };
  f.sources.linkByCode.mockResolvedValue({
    ...f.sources.row,
    link_id: f.sources.row.link_id!,
    scene: 'share',
  });
  expect(
    await runFresh(f, { sources: { ...f.sources.ports, clickCode: () => true } }),
  ).toMatchObject({ ok: true });
  expect((await f.read()).orders[0]).toMatchObject({
    ...f.sources.expected,
    source_match: 'exact',
    source_scene: 'share',
  });
  expect(f.sources.linkByCode).toHaveBeenCalledExactlyOnceWith({
    appId: f.ctx.app_id,
    platform: 'pdd',
    lk: 'a1b2c3',
  });
  expectSourceWrite(f.queries, 'insert');
  expectPrivateLogs(f);
});

it.each(['productKey', 'linkLogs', 'linkByCode'] as const)(
  '[AC-B1-08j#30] 首次回填 %s 抛错，判定前不写订单，事务与事件不留残留',
  async (port) => {
    const f = await fresh(db);
    f.incoming = {
      ...f.incoming,
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
      },
    };
    const before = await f.read();
    const failure = new Error(`source ${port} unavailable`);
    f.sources[port].mockRejectedValue(failure);
    const result = await runFresh(f, { sources: { ...f.sources.ports, clickCode: () => true } });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toBe(failure);
    expect(await f.read()).toEqual(before);
    expect(f.onImported).not.toHaveBeenCalled();
    expect(
      f.queries.filter((q) => /^(insert into|update) "app"\."(orders|order_keys)"/i.test(q.sql)),
    ).toHaveLength(0);
  },
);

it('[AC-B1-08j#31] 预售回填以定金 attr_at 为准，不看尾款 paid_at 或当前时钟', async () => {
  const f = await fresh(db);
  f.incoming = { ...f.incoming, deposit_paid_at: at('2026-10-14T06:07:08Z') };
  f.sources.linkLogs.mockResolvedValue([f.sources.row]);
  expect(await runFresh(f)).toMatchObject({ ok: true });
  // The only click is later than the deposit and earlier than paid_at: it cannot match.
  expect((await f.read()).orders[0]).toMatchObject({
    ...NONE,
    attr_at: f.incoming.deposit_paid_at,
  });
  expect(f.sources.linkLogs).toHaveBeenCalledExactlyOnceWith({
    appId: f.ctx.app_id,
    userId: f.userId,
    platform: 'pdd',
    from: at('2026-09-29T06:07:08Z'),
    to: f.incoming.deposit_paid_at,
  });
});
