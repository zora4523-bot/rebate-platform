import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  business,
  expectPrivateLogs,
  expectSourceWrite,
  expectWindow,
  runUpdate,
  scenario,
  sourcesFor,
} from './db-kit.ts';
import { at } from './kit.ts';

// Global setup supplies the migrated template; queries use the ordinary application role.
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

it.each(['UNATTRIBUTED', 'VOID'])(
  '[AC-B1-08j#32] %s 空身份重跑成功，四列和 user_id 在同一 CAS UPDATE 写入',
  async (rebate_status) => {
    const f = await scenario(db, {}, { unattributed: true });
    const s = await sourcesFor(f);
    await db
      .updateTable('orders')
      .set({
        rebate_status,
        settle_commission_fen: 701n,
        subsidy_commission_fen: 23n,
        booked_base_fen: 611n,
        booked_n_fen: 421n,
        initial_est_fen: 733n,
        n_total_fen: 431n,
        pre_base_deduct_fen: 17n,
        base_fen: 601n,
        platform_est_profit_fen: 79n,
        commission_rate_bp: 123,
        commission_rate_min_bp: 101,
        commission_rate_max_bp: 199,
      })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    const before = (await f.read()).orders[0]!;
    f.findUser.mockResolvedValue(f.userId);
    f.findPid.mockClear();
    f.queries.length = 0;
    const next = f.next({
      promotion_slot: 'incoming-other-pid',
      paid_at: at('2026-10-16T06:07:08Z'),
    });
    expect(await runUpdate(f, s.ports, next)).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    const after = (await f.read()).orders[0]!;
    expect(after).toMatchObject({
      ...s.expected,
      user_id: f.userId,
      user_basis: 'param',
      row_version: before.row_version + 1,
    });
    expect(business(after)).toEqual({
      ...business(before),
      user_id: f.userId,
      user_basis: 'param',
    });
    expectWindow(f, s);
    expect(s.productKey).toHaveBeenCalledExactlyOnceWith({ platform: 'pdd', order: next });
    expect(f.findPid).toHaveBeenCalledExactlyOnceWith({
      appId: f.ctx.app_id,
      platform: 'pdd',
      unionAccountId: f.ctx.union_account_id,
      pid: 'incoming-other-pid',
    });
    expectSourceWrite(f.queries, 'update');
    expect(f.onUpdated.mock.calls[0]?.[1].attributed_now).toBe(true);
    expectPrivateLogs(f);
  },
);

it('[AC-B1-08j#33] 重跑使用 current.shop_id：商品不可用时写 shop，不改商品或店铺列', async () => {
  const f = await scenario(db, {}, { unattributed: true });
  const s = await sourcesFor(f);
  await db
    .updateTable('orders')
    .set({ shop_id: 'shop-1' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  s.productKey.mockResolvedValue(null);
  f.findUser.mockResolvedValue(f.userId);
  f.queries.length = 0;
  expect(await runUpdate(f, s.ports)).toMatchObject({ ok: true });
  expect((await f.read()).orders[0]).toMatchObject({
    ...s.expected,
    source_match: 'shop',
    shop_id: 'shop-1',
    product_key: null,
  });
  expectSourceWrite(f.queries, 'update');
  const set = f.queries
    .find((q) => /^update "app"\."orders"/i.test(q.sql))!
    .sql.split(' where ')[0];
  expect(set).not.toMatch(/"(shop_id|product_key)"\s*=/i);
});

it.each(['missing-row', 'missing-port'] as const)(
  '[AC-B1-08j#34] 推广位 %s 时按 fallback 匹配并告警',
  async (condition) => {
    const f = await scenario(db, {}, { unattributed: true });
    const s = await sourcesFor(f);
    s.linkLogs.mockResolvedValue([{ ...s.row, pid_scene: 'self_buy' }]);
    f.findUser.mockResolvedValue(f.userId);
    f.findPid.mockResolvedValue([]);
    expect(await runUpdate(f, s.ports, f.next(), {}, condition === 'missing-port')).toMatchObject({
      ok: true,
    });
    expect((await f.read()).orders[0]).toMatchObject(s.expected);
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ app_id: f.ctx.app_id, platform: 'pdd' }),
      expect.any(String),
    );
    expectPrivateLogs(f);
  },
);

it('[AC-B1-08j#35] 重跑取推广位第一行 pid_scene，而非第二行或 incoming pid', async () => {
  const f = await scenario(db, {}, { unattributed: true });
  const s = await sourcesFor(f);
  f.findUser.mockResolvedValue(f.userId);
  f.findPid.mockResolvedValue([
    { pid_scene: 'agent', status: 'active', site_id: null },
    { pid_scene: 'share', status: 'active', site_id: null },
  ]);
  s.linkLogs.mockResolvedValue([{ ...s.row, pid_scene: 'agent', scene: 'search' }, s.row]);
  expect(await runUpdate(f, s.ports)).toMatchObject({ ok: true });
  expect((await f.read()).orders[0]).toMatchObject({ ...s.expected, source_scene: 'search' });
});

it.each(['productKey', 'linkLogs', 'linkByCode'] as const)(
  '[AC-B1-08j#36] 重跑 %s 抛错，订单/历史/计数/事件全部回滚',
  async (port) => {
    const f = await scenario(db, {}, { unattributed: true });
    const s = await sourcesFor(f);
    f.findUser.mockResolvedValue(f.userId);
    const failure = new Error(`source ${port} failed`);
    s[port].mockRejectedValue(failure);
    const before = await f.read();
    f.queries.length = 0;
    const next = f.next({
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
      },
    });
    const result = await runUpdate(f, { ...s.ports, clickCode: () => true }, next);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toBe(failure);
    expect(await f.read()).toEqual(before);
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.queries.filter((q) => /^update "app"\."orders"/i.test(q.sql))).toHaveLength(0);
  },
);
