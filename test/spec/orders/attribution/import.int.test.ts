import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, ATTR, NOW, RECEIVED, SETTLED, fixture, pipeline, snapshot } from './kit.ts';

// Global setup injects the template connection; each file clones it and uses couli_app.
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

it.each(['pending', 'active', 'retired'])(
  '[AC-B1-08h#23] 推广位 status=%s 仍属本 App，P2 两表共享 UUIDv7 与 attr_at',
  async (status) => {
    const f = await fixture(db);
    f.findPid.mockResolvedValue([{ pid_scene: 'share', status, site_id: null }]);
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const saved = await snapshot(db, f.ctx.app_id);
    expect(saved.keys).toHaveLength(1);
    expect(saved.orders).toHaveLength(1);
    const row = saved.orders[0]!;
    expect(row.order_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(saved.keys[0]).toMatchObject({
      app_id: f.ctx.app_id,
      platform: 'pdd',
      sub_order_id: f.incoming.sub_order_id,
      order_id: row.order_id,
      attr_at: at(ATTR),
    });
    expect(row).toMatchObject({
      app_id: f.ctx.app_id,
      platform: 'pdd',
      sub_order_id: f.incoming.sub_order_id,
      parent_order_id: 'synthetic-parent',
      raw_item_id: 'synthetic-item',
      attr_at: at(ATTR),
      pay_amount_fen: 12345n,
      est_commission_fen: 789n,
      pid: 'slot-ours',
      custom_params: f.incoming.attr_params!.custom_parameters,
      relation_id: null,
      sub_union_id: null,
      deposit_paid_at: null,
      paid_at: at(ATTR),
      received_at: null,
      settled_at: null,
      platform_modified_at: f.incoming.modified_at,
      is_presale: false,
      user_id: f.userId,
      user_basis: 'param',
      buy_type: 'share',
      scene_basis: 'pid',
      platform_status: 'PAID',
      rebate_status: 'UNATTRIBUTED',
      locked: false,
      raw_payload_id: 101n,
      product_key: null,
      settle_commission_fen: null,
    });
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.history).toEqual([
      expect.objectContaining({
        order_id: row.order_id,
        app_id: f.ctx.app_id,
        field: 'platform',
        source: 'sync',
        from_status: null,
        event: 'PLATFORM_PAID',
        to_status: 'PAID',
        at: at(NOW),
      }),
    ]);
    expect(saved.counters).toEqual([]);
    expect(saved.pending).toEqual([]);
    expect(f.findPid).toHaveBeenCalledWith({
      appId: f.ctx.app_id,
      platform: 'pdd',
      unionAccountId: f.ctx.union_account_id,
      pid: 'slot-ours',
    });
    expect(f.syncStartAt).toHaveBeenCalledWith({
      appId: f.ctx.app_id,
      unionAccountId: f.ctx.union_account_id,
    });
    expect(f.findUser).toHaveBeenCalledWith({ appId: f.ctx.app_id, attrCode: 'abcd1234' });
    expect(f.onImported).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      app_id: f.ctx.app_id,
      order_id: row.order_id,
      attr_at: at(ATTR),
      attributed: true,
      platform_status: 'PAID',
      received_at: null,
    });
  },
);

it.each([
  { raw_status: 'deposit', states: ['DEPOSIT_PAID'], received: null, settled: null },
  { raw_status: 'invalid', states: ['INVALID'], received: null, settled: null },
  { raw_status: 'received', states: ['PAID', 'RECEIVED'], received: RECEIVED, settled: null },
  {
    raw_status: 'settled',
    states: ['PAID', 'RECEIVED', 'SETTLED'],
    received: RECEIVED,
    settled: SETTLED,
  },
  {
    raw_status: 'settled',
    states: ['PAID', 'RECEIVED', 'SETTLED'],
    received: null,
    settled: SETTLED,
  },
])(
  '[AC-B1-08h#24] 首次 $raw_status 保存完整 history 与时间',
  async ({ raw_status, states, received, settled }) => {
    const f = await fixture(db, {
      raw_status,
      received_at: received ? at(received) : null,
      settled_at: settled ? at(settled) : null,
    });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const saved = await snapshot(db, f.ctx.app_id);
    expect(saved.orders[0]).toMatchObject({
      platform_status: states.at(-1),
      received_at: received ? at(received) : settled ? at(settled) : null,
      settled_at: settled ? at(settled) : null,
      rebate_status: 'UNATTRIBUTED',
    });
    expect(saved.history.map((r) => [r.from_status, r.to_status, r.event])).toEqual(
      states.map((state, i) => [i === 0 ? null : states[i - 1], state, `PLATFORM_${state}`]),
    );
    expect(
      saved.history.every(
        (r) => r.field === 'platform' && r.source === 'sync' && r.at.toISOString() === NOW,
      ),
    ).toBe(true);
    expect(f.onImported).toHaveBeenCalledTimes(1);
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({
      platform_status: states.at(-1),
      received_at: saved.orders[0]!.received_at,
    });
  },
);

it('[AC-B1-08h#25] 定金归因优先于尾款，等于同步起点可以入库', async () => {
  const f = await fixture(db, {
    deposit_paid_at: at(ATTR),
    paid_at: at('2026-10-17T06:07:08.000Z'),
  });
  f.syncStartAt.mockResolvedValue(at(ATTR));
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders[0]).toMatchObject({
    attr_at: at(ATTR),
    is_presale: true,
    deposit_paid_at: at(ATTR),
    paid_at: f.incoming.paid_at,
  });
  expect(s.keys[0]?.attr_at).toEqual(at(ATTR));
});

it.each(['received', 'settled'])(
  '[AC-B1-08h#26] 首次 %s 缺收货时间保存 PAID 与带 order_id 的待处理项',
  async (raw_status) => {
    const f = await fixture(db, { raw_status });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.history).toHaveLength(1);
    expect(s.orders[0]).toMatchObject({ platform_status: 'PAID', received_at: null });
    expect(s.pending).toEqual([
      expect.objectContaining({
        order_id: s.orders[0]!.order_id,
        reason: 'NO_RECEIVED_AT',
        status: 'open',
      }),
    ]);
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({
      platform_status: 'PAID',
      received_at: null,
    });
  },
);

it('[AC-B1-08h#27] 返利端口可在同事务读入库结果，另一连接提交前不可见', async () => {
  const f = await fixture(db);
  f.onImported.mockImplementation(async (trx, imported) => {
    expect(trx.isTransaction).toBe(true);
    expect(
      await trx
        .selectFrom('orders')
        .select('order_id')
        .where('order_id', '=', imported.order_id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await trx
        .selectFrom('order_keys')
        .select('order_id')
        .where('order_id', '=', imported.order_id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await trx
        .selectFrom('order_status_history')
        .select('id')
        .where('order_id', '=', imported.order_id)
        .execute(),
    ).toHaveLength(1);
    expect((await snapshot(db, f.ctx.app_id)).orders).toEqual([]);
  });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08h#28] 返利端口失败回滚 keys、orders、history、未归因计数与 pending', async () => {
  const f = await fixture(db, {
    raw_status: 'received',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: 'bad' },
  });
  f.onImported.mockRejectedValue(new Error('synthetic rebate failure'));
  const p = await pipeline(f.deps);
  const before = await snapshot(db, f.ctx.app_id);
  await expect(p.process(f.incoming, f.ctx)).rejects.toThrow('synthetic rebate failure');
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  f.onImported.mockResolvedValue(undefined);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders).toHaveLength(1);
  expect(s.counters[0]?.count).toBe(1n);
});
