import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  EMPTY_SOURCE,
  NONE,
  expectPendingLog,
  expectShopCas,
  matched,
  runUpdate,
  scenario,
  sourcesFor,
  stableBusiness,
} from './db-kit.ts';

// 全局 setup 提供模板克隆入口，业务查询均为 couli_app。
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

it.each(['73129', null])(
  '[AC-B1-08p#15] 未归因重跑成功用 incoming 店铺 %s，缺失则待补',
  async (shop_id) => {
    const f = await scenario(db, { shop_id: null }, { unattributed: true });
    const s = await sourcesFor(f);
    const click = { ...s.row, shop_id: '73129', pid_scene: 'agent' };
    s.productKey.mockResolvedValue(null);
    s.linkLogs.mockResolvedValue([click]);
    f.findUser.mockResolvedValue(f.userId);
    f.findPid.mockClear();
    f.findPid.mockImplementation(async ({ pid }) => [
      {
        pid_scene: pid === 'incoming-agent' ? 'agent' : 'share',
        status: 'active',
        site_id: null,
      },
    ]);
    f.queries.length = 0;
    const result = await runUpdate(
      f,
      s.ports,
      f.next({ shop_id, promotion_slot: 'incoming-agent' }),
    );
    expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
    const after = (await f.read()).orders[0]!;
    expect(after).toMatchObject({
      ...(shop_id === null ? EMPTY_SOURCE : matched(click, 'shop')),
      shop_id,
      user_id: f.userId,
      user_basis: 'param',
      pid: 'incoming-agent',
    });
    expect(stableBusiness(after)).toEqual({
      ...stableBusiness(f.original),
      user_id: f.userId,
      user_basis: 'param',
    });
    expect(f.findPid).toHaveBeenCalledExactlyOnceWith({
      appId: f.ctx.app_id,
      platform: 'pdd',
      unionAccountId: f.ctx.union_account_id,
      pid: 'incoming-agent',
    });
    if (shop_id === null) expectPendingLog(f);
    else expectShopCas(f.queries, true);
  },
);

it('[AC-B1-08p#16] 已存店铺优先于 incoming；非空值不被替换或擦掉', async () => {
  const f = await scenario(db, { shop_id: '73129' }, { unattributed: true });
  const s = await sourcesFor(f);
  const click = { ...s.row, shop_id: '73129' };
  s.productKey.mockResolvedValue(null);
  s.linkLogs.mockResolvedValue([click]);
  f.findUser.mockResolvedValue(f.userId);
  expect(f.original.shop_id).toBe('73129');
  for (const shop_id of ['different-shop', null, undefined]) {
    f.queries.length = 0;
    f.clock.advanceMs(83_000);
    const { shop_id: ignored, ...withoutShop } = f.next();
    void ignored;
    const incoming = shop_id === undefined ? withoutShop : { ...withoutShop, shop_id };
    const result = await runUpdate(f, s.ports, incoming);
    expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...matched(click, 'shop'),
      shop_id: '73129',
    });
    const set = f.queries
      .find((q) => /^update "app"\."orders"/i.test(q.sql))!
      .sql.split(' where ')[0];
    expect(set).not.toMatch(/"(shop_id|product_key)"\s*=/i);
  }
  expect(s.linkLogs).toHaveBeenCalledTimes(1);
});

it.each(['none', 'product', 'shop', 'exact'] as const)(
  '[AC-B1-08p#17] 已终结 %s 只补空店铺、不重跑或覆盖四列',
  async (kind) => {
    const f = await scenario(db, { shop_id: null });
    const s = await sourcesFor(f);
    const stored = kind === 'none' ? NONE : { ...s.expected, source_match: kind };
    await db.updateTable('orders').set(stored).where('app_id', '=', f.ctx.app_id).execute();
    f.queries.length = 0;
    const result = await runUpdate(f, s.ports, f.next({ shop_id: '73129' }));
    expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({ ...stored, shop_id: '73129' });
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();
    const set = f.queries
      .find((q) => /^update "app"\."orders"/i.test(q.sql))!
      .sql.split(' where ')[0];
    expect(set).not.toMatch(/"(source_match|source_scene|link_id|agent_session_id)"\s*=/i);
  },
);

it('[AC-B1-08p#18] 只有满足触发条件才回填；locked、失败、未注入、无店铺能力均不重跑', async () => {
  // 同入口正例：后到店铺必须真正触发，不能用整体禁用 sources 通过负例。
  const control = await scenario(db, { shop_id: null });
  const positive = await sourcesFor(control);
  const filled = await runUpdate(control, positive.ports, control.next({ shop_id: '73129' }));
  expect(filled).toMatchObject({ ok: true });
  expect((await control.read()).orders[0]).toMatchObject(positive.expected);
  for (const condition of ['locked', 'failed', 'no-sources', 'unsupported'] as const) {
    const f = await scenario(
      db,
      {},
      { unattributed: condition === 'locked' || condition === 'failed' },
    );
    const s = await sourcesFor(f);
    if (condition === 'locked') {
      f.findUser.mockResolvedValue(f.userId);
      await db
        .updateTable('orders')
        .set({ locked: true })
        .where('app_id', '=', f.ctx.app_id)
        .execute();
    }
    const result = await runUpdate(
      f,
      condition === 'no-sources' ? undefined : s.ports,
      condition === 'unsupported' ? f.next() : f.next({ shop_id: '73129' }),
    );
    expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject(EMPTY_SOURCE);
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();
  }
});

it('[AC-B1-08p#19] 两次并发同步同一后到店铺只回填一次，不串 app', async () => {
  const f = await scenario(db, { shop_id: null });
  const other = await scenario(db, { shop_id: null, sub_order_id: 'another-child' });
  const otherBefore = await other.read();
  const s = await sourcesFor(f);
  s.productKey.mockResolvedValue(null);
  const click = { ...s.row, shop_id: '73129' };
  s.linkLogs.mockResolvedValue([click]);
  f.queries.length = 0;
  const incoming = f.next({ shop_id: '73129' });
  const results = await Promise.all([
    runUpdate(f, s.ports, incoming),
    runUpdate(f, s.ports, incoming),
  ]);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ kind: 'updated' }) }),
      expect.objectContaining({ ok: true, value: expect.objectContaining({ kind: 'unchanged' }) }),
    ]),
  );
  expect((await f.read()).orders[0]).toMatchObject({
    ...matched(click, 'shop'),
    shop_id: '73129',
    row_version: f.original.row_version + 1,
  });
  expect(s.linkLogs).toHaveBeenCalledTimes(1);
  expectShopCas(f.queries);
  expect(await other.read()).toEqual(otherBefore);
});
