import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  EMPTY_SOURCE,
  NONE,
  at,
  expectPrivate,
  expectShopCas,
  matched,
  runUpdate,
  scenario,
  sourcesFor,
  stableBusiness,
} from './db-kit.ts';

// 使用全局 setup 的模板克隆，查询身份为 couli_app。
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

it.each(['shop', 'none'] as const)(
  '[AC-B1-08p#11] 待补单先不重跑，店铺到来同一 CAS 终结为 %s，以后不重跑',
  async (kind) => {
    const f = await scenario(db, { shop_id: null });
    const s = await sourcesFor(f);
    const click = { ...s.row, shop_id: '73129' };
    // 非零账务哨兵，避免误清零被全零夹具掩盖；来源回填不能写这些列。
    await db
      .updateTable('orders')
      .set({
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
    s.productKey.mockResolvedValue(null);
    s.linkLogs.mockResolvedValue(kind === 'shop' ? [click] : []);
    // scene 未改变的更新应使用库内 pid；传入不同 pid 不得把已归属订单串场景。
    f.findPid.mockImplementation(async ({ pid }) => [
      {
        pid_scene: pid === f.original.pid ? 'share' : 'agent',
        status: 'active',
        site_id: null,
      },
    ]);
    const stillEmpty = f.next({ shop_id: null });
    const waiting = await runUpdate(f, s.ports, stillEmpty);
    expect(waiting).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject(EMPTY_SOURCE);
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();

    const before = (await f.read()).orders[0]!;
    f.clock.advanceMs(61_000);
    f.findPid.mockClear();
    f.queries.length = 0;
    // 只改 shop_id（modified_at / raw_payload_id 不变），验证 hash 必须感知后到店铺。
    const incoming = { ...stillEmpty, shop_id: '73129' };
    const filled = await runUpdate(f, s.ports, incoming);
    expect(filled).toMatchObject({ ok: true, value: { kind: 'updated' } });
    const expected = kind === 'shop' ? matched(click, 'shop') : NONE;
    const after = (await f.read()).orders[0]!;
    expect(after).toMatchObject({
      ...expected,
      shop_id: '73129',
      row_version: before.row_version + 1,
    });
    expect(stableBusiness(after)).toEqual(stableBusiness(before));
    expect(after.content_hash).not.toBe(before.content_hash);
    expectShopCas(f.queries);
    expect(s.linkLogs).toHaveBeenCalledExactlyOnceWith({
      appId: f.ctx.app_id,
      userId: f.userId,
      platform: 'pdd',
      from: at('2026-09-30T16:00:00Z'),
      to: f.original.attr_at,
    });
    expect(f.findPid).toHaveBeenCalledExactlyOnceWith({
      appId: f.ctx.app_id,
      platform: 'pdd',
      unionAccountId: f.ctx.union_account_id,
      pid: f.original.pid,
    });
    expect(f.onUpdated.mock.calls.at(-1)?.[1].attributed_now).toBe(false);
    expect(f.onUpdated.mock.calls.at(-1)?.[1]).not.toHaveProperty('shop_id');

    s.linkLogs.mockClear();
    s.productKey.mockClear();
    s.linkByCode.mockClear();
    f.clock.advanceMs(67_000);
    f.queries.length = 0;
    const repeated = await runUpdate(
      f,
      s.ports,
      f.next({ shop_id: 'different-shop', promotion_slot: 'different-pid' }),
    );
    expect(repeated).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...expected,
      shop_id: '73129',
      user_id: f.userId,
    });
    expect(s.linkLogs).not.toHaveBeenCalled();
    expect(s.productKey).not.toHaveBeenCalled();
    expect(s.linkByCode).not.toHaveBeenCalled();
    const set = f.queries
      .find((q) => /^update "app"\."orders"/i.test(q.sql))!
      .sql.split(' where ')[0];
    expect(set).not.toMatch(/"(shop_id|source_match|source_scene|link_id|agent_session_id)"\s*=/i);
    expectPrivate(f);
  },
);

it('[AC-B1-08p#12] 已归属的店铺重试仍取 current pid / attr_at / user_id，而非后来报文', async () => {
  const f = await scenario(db, { shop_id: null });
  const s = await sourcesFor(f);
  s.productKey.mockResolvedValue(null);
  const click = { ...s.row, shop_id: '73129' };
  s.linkLogs.mockResolvedValue([click]);
  f.findPid.mockClear();
  f.findPid.mockImplementation(async ({ pid }) => [
    {
      pid_scene: pid === f.original.pid ? 'share' : 'agent',
      status: 'active',
      site_id: null,
    },
  ]);
  f.findUser.mockResolvedValue(null);
  const incoming = f.next({
    shop_id: '73129',
    promotion_slot: 'other-pid',
    paid_at: at('2026-10-16T08:10:11Z'),
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"other123"}',
    },
  });
  f.queries.length = 0;
  const result = await runUpdate(f, s.ports, incoming);
  expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect((await f.read()).orders[0]).toMatchObject({
    ...matched(click, 'shop'),
    shop_id: '73129',
    user_id: f.userId,
    attr_at: f.original.attr_at,
    pid: f.original.pid,
  });
  expect(s.linkLogs).toHaveBeenCalledExactlyOnceWith({
    appId: f.ctx.app_id,
    userId: f.userId,
    platform: 'pdd',
    from: at('2026-09-30T16:00:00Z'),
    to: f.original.attr_at,
  });
  expect(f.findUser).not.toHaveBeenCalled();
  expectShopCas(f.queries);
});

it.each(['settled', 'invalid'] as const)(
  '[AC-B1-08p#13] 店铺不来不因 %s 或时间推移放弃，后来补到仍可回填',
  async (raw_status) => {
    // BR-ATTR-15 未给重试次数或放弃条件；采用任务补充口径 6，时间不扩展 attr_at 窗口。
    const f = await scenario(db, { shop_id: null });
    const s = await sourcesFor(f);
    s.productKey.mockResolvedValue(null);
    const click = { ...s.row, shop_id: '73129' };
    s.linkLogs.mockResolvedValue([click]);
    f.clock.advanceMs(45 * 24 * 60 * 60 * 1000);
    const last = f.next({
      shop_id: null,
      raw_status,
      received_at: at('2026-10-16T03:04:05Z'),
      settled_at: at('2026-10-17T04:05:06Z'),
    });
    for (let i = 0; i < 3; i++) {
      f.clock.advanceMs(73_000);
      const result = await runUpdate(f, s.ports, { ...last, modified_at: f.clock.now() });
      expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
      expect((await f.read()).orders[0]).toMatchObject(EMPTY_SOURCE);
      expect(s.linkLogs).not.toHaveBeenCalled();
    }
    f.clock.advanceMs(79_000);
    const filled = await runUpdate(f, s.ports, {
      ...last,
      shop_id: '73129',
      modified_at: f.clock.now(),
    });
    expect(filled).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...matched(click, 'shop'),
      shop_id: '73129',
    });
    expect(s.linkLogs).toHaveBeenCalledTimes(1);
    expect(s.linkLogs.mock.calls[0]![0].to).toEqual(f.original.attr_at);
  },
);

it.each(['productKey', 'linkLogs'] as const)(
  '[AC-B1-08p#14] 后到店铺的 %s 失败时原值与事件不变，恢复后仍能回填',
  async (port) => {
    const f = await scenario(db, { shop_id: null });
    const s = await sourcesFor(f);
    const failure = new Error('synthetic source read failed');
    s[port].mockRejectedValueOnce(failure);
    const before = await f.read();
    const incoming = f.next({ shop_id: '73129' });
    const failed = await runUpdate(f, s.ports, incoming);
    expect(failed).toMatchObject({ ok: false });
    if (!failed.ok) expect(failed.error).toBe(failure);
    expect(await f.read()).toEqual(before);
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    const recovered = await runUpdate(f, s.ports, incoming);
    expect(recovered).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({ ...s.expected, shop_id: '73129' });
  },
);

it.each(['exact', 'product'] as const)(
  '[AC-B1-08p#20] 后到店铺回填时 %s 仍优先于 shop',
  async (kind) => {
    const f = await scenario(db, { shop_id: null });
    const s = await sourcesFor(f);
    s.linkLogs.mockResolvedValue([{ ...s.row, shop_id: '73129' }]);
    if (kind === 'exact') s.linkByCode.mockResolvedValue({ ...s.row, link_id: s.row.link_id! });
    const incoming = f.next({
      shop_id: '73129',
      attr_params: {
        relation_id: null,
        sub_union_id: null,
        custom_parameters: '{"app":"n","uid":"abcd1234","lk":"a1b2c3"}',
      },
    });
    f.queries.length = 0;
    const result = await runUpdate(f, { ...s.ports, clickCode: () => kind === 'exact' }, incoming);
    expect(result).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.read()).orders[0]).toMatchObject({
      ...s.expected,
      source_match: kind,
      shop_id: '73129',
    });
    expectShopCas(f.queries);
    if (kind === 'exact') {
      expect(s.linkLogs).not.toHaveBeenCalled();
      expect(s.productKey).not.toHaveBeenCalled();
    } else expect(s.linkLogs).toHaveBeenCalledTimes(1);
  },
);
