import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  EMPTY_SOURCE,
  fresh,
  runFresh,
  NONE,
  matched,
  expectPendingLog,
  expectPrivate,
  runUpdate,
  scenario,
  sourcesFor,
} from './db-kit.ts';

// 全局 setup 注入已迁移的模板，逐文件克隆；业务查询只用 couli_app。
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

it.each([false, true])(
  '[AC-B1-08p#7] 首次入库写店铺，未归因=%s，不扩充结算载荷',
  async (unattributed) => {
    const f = await fresh(db);
    f.incoming = { ...f.incoming, shop_id: '73129' };
    if (unattributed) f.findUser.mockResolvedValue(null);
    const result = await runFresh(f);
    expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    const row = (await f.read()).orders[0]!;
    expect(row).toMatchObject({
      shop_id: '73129',
      user_id: unattributed ? null : f.userId,
      pay_amount_fen: 12345n,
      est_commission_fen: 789n,
      buy_type: 'share',
      product_key: null,
    });
    expect(row).toMatchObject(unattributed ? EMPTY_SOURCE : f.sources.expected);
    expect(f.onImported).toHaveBeenCalledTimes(1);
    expect(Object.keys(f.onImported.mock.calls[0]![1]).sort()).toEqual([
      'app_id',
      'attr_at',
      'attributed',
      'order_id',
      'platform_status',
      'received_at',
    ]);
    const inserts = f.queries.filter((q) => /^insert into "app"\."orders"/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('"shop_id"');
    expectPrivate(f);
  },
);

it('[AC-B1-08p#8] 首次订单同店异品通过 shop 命中，身份金额不变', async () => {
  const f = await fresh(db);
  f.incoming = { ...f.incoming, shop_id: '73129' };
  f.sources.productKey.mockResolvedValue('pdd:other-product');
  const click = { ...f.sources.row, shop_id: '73129' };
  f.sources.linkLogs.mockResolvedValue([click]);
  const result = await runFresh(f);
  expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect((await f.read()).orders[0]).toMatchObject({
    ...matched(click, 'shop'),
    shop_id: '73129',
    user_id: f.userId,
    buy_type: 'share',
    product_key: null,
    pay_amount_fen: 12345n,
    est_commission_fen: 789n,
  });
  expectPrivate(f);
});

it('[AC-B1-08p#9] 显式 null 待补；字段缺失或场景未知仍终结为 none', async () => {
  for (const condition of ['pending', 'unsupported'] as const) {
    const f = await fresh(db);
    if (condition !== 'unsupported') f.incoming = { ...f.incoming, shop_id: null };
    f.sources.productKey.mockResolvedValue(null);
    f.sources.linkLogs.mockResolvedValue([]);
    const result = await runFresh(f);
    expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...(condition === 'pending' ? EMPTY_SOURCE : NONE),
      shop_id: null,
      user_id: f.userId,
    });
    if (condition === 'pending') expectPendingLog(f);
    else
      expect(f.logger.info.mock.calls.filter(([x]) => x.outcome === 'source_pending')).toEqual([]);
  }
  // fresh 的推广位缺行会在 App 判定阶段丢单；场景未知使用已有订单的归属重跑入口。
  const f = await scenario(db, { shop_id: null }, { unattributed: true });
  const s = await sourcesFor(f);
  f.findUser.mockResolvedValue(f.userId);
  f.findPid.mockResolvedValue([]);
  const result = await runUpdate(f, s.ports, f.next({ shop_id: null }));
  expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect((await f.read()).orders[0]).toMatchObject({ ...NONE, user_id: f.userId });
  expect(s.linkLogs).not.toHaveBeenCalled();
  expect(f.logger.info.mock.calls.filter(([x]) => x.outcome === 'source_pending')).toEqual([]);
});

it.each(['exact', 'product'] as const)(
  '[AC-B1-08p#10] 缺店铺时 %s 命中立即终结，只有无命中才暂缓',
  async (kind) => {
    for (const hit of [false, true]) {
      const f = await fresh(db);
      f.incoming = {
        ...f.incoming,
        shop_id: null,
        attr_params: {
          relation_id: null,
          sub_union_id: null,
          custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
        },
      };
      f.sources.linkLogs.mockResolvedValue(hit ? [f.sources.row] : []);
      if (hit && kind === 'exact')
        f.sources.linkByCode.mockResolvedValue({
          ...f.sources.row,
          link_id: f.sources.row.link_id!,
        });
      const result = await runFresh(f, {
        sources: { ...f.sources.ports, clickCode: () => kind === 'exact' },
      });
      expect(result).toMatchObject({ ok: true });
      expect((await f.read()).orders[0]).toMatchObject(
        hit ? { ...f.sources.expected, source_match: kind, shop_id: null } : EMPTY_SOURCE,
      );
      if (!hit) expectPendingLog(f);
      if (hit && kind === 'exact') expect(f.sources.linkLogs).not.toHaveBeenCalled();
    }
  },
);
