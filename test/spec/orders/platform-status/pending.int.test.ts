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
import { at, expectAlert, expectSafeLogs, RECEIVED, scenario, SETTLED } from './kit.ts';

function expectUnmappedAlert(f: Awaited<ReturnType<typeof scenario>>) {
  expect([...f.logger.warn.mock.calls, ...f.logger.error.mock.calls]).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([
        expect.objectContaining({
          alert: expect.any(String),
          event: 'order_illegal_transition',
          platform: 'pdd',
          app_id: f.ctx.app_id,
          outcome: expect.any(String),
        }),
      ]),
    ]),
  );
  expectSafeLogs(f);
}

it.each([
  { initial: 'received', raw: 'paid', from: 'RECEIVED', event: 'PLATFORM_PAID', rule: 'P10' },
  {
    initial: 'deposit',
    raw: 'rights',
    from: 'DEPOSIT_PAID',
    event: 'PLATFORM_RIGHTS',
    rule: 'illegal',
  },
] as const)(
  '[AC-B1-08i#24] $rule 整条不落订单列，重复 pending 只刷新 detected_at',
  async ({ initial, raw, from, event, rule }) => {
    const f = await scenario(db, {
      raw_status: initial,
      ...(initial === 'received'
        ? { received_at: at(RECEIVED) }
        : { deposit_paid_at: at('2026-10-14T03:04:05Z'), paid_at: null }),
    });
    const incoming = f.next({
      raw_status: raw,
      paid_fen: 321n,
      est_commission_fen: 999n,
      settle_commission_fen: 888n,
      received_at: at('2026-10-17T01:02:03Z'),
      settled_at: at(SETTLED),
      parent_order_id: 'changed-parent',
      goods_id: 'changed-item',
      attr_params: {
        relation_id: 'private-relation',
        sub_union_id: 'private-sub',
        custom_parameters: 'private-buyer',
      },
    });
    const first = await f.pipeline.process(incoming, f.ctx);
    expect(first).toEqual({
      kind: 'pending',
      order_id: f.original.order_id,
      reason: 'ILLEGAL_TRANSITION',
    });
    const after = await f.read();
    expect(after.orders).toEqual(f.before.orders);
    expect(after.history).toEqual(f.before.history);
    expect(after.keys).toEqual(f.before.keys);
    expect(after.counters).toEqual(f.before.counters);
    expect(after.pending).toEqual([
      expect.objectContaining({
        app_id: f.ctx.app_id,
        order_id: f.original.order_id,
        reason: 'ILLEGAL_TRANSITION',
        raw_status: raw,
        raw_payload_id: 202n,
        status: 'open',
        detected_at: f.clock.now(),
        detail: `order_illegal_transition ${rule} ${from}→${event}`,
      }),
    ]);
    expect(f.publishedOf('order.updated')).toHaveLength(0);
    expect(f.publishedOf('order.created')).toHaveLength(0);
    expectAlert(
      f,
      'order.illegal_transition',
      {
        reason: 'ILLEGAL_TRANSITION',
        from_status: from,
      },
      ['private-relation', 'private-sub', 'private-buyer'],
    );
    f.publish.mockClear();
    f.clock.advanceMs(70_000);
    expect(await f.pipeline.process({ ...incoming, raw_payload_id: '303' }, f.ctx)).toEqual(first);
    const repeated = await f.read();
    expect(repeated.pending).toEqual(
      after.pending.map((p) => ({ ...p, detected_at: f.clock.now() })),
    );
    expect(repeated.orders).toEqual(f.before.orders);
    expect(repeated.history).toEqual(f.before.history);
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect(f.onUnmappedStatus).not.toHaveBeenCalled();
    expect(f.publishedOf('order.updated')).toHaveLength(0);
    expect(f.publishedOf('order.created')).toHaveLength(0);
    expectAlert(
      f,
      'order.illegal_transition',
      {
        reason: 'ILLEGAL_TRANSITION',
        from_status: from,
      },
      ['private-relation', 'private-sub', 'private-buyer'],
    );
    expect(f.findUser).not.toHaveBeenCalled();
    expect(f.queries.some((q) => /^update "app"."orders"/i.test(q.sql))).toBe(false);
    expect(f.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: expect.any(String),
        event: 'order_illegal_transition',
        platform: 'pdd',
        app_id: f.ctx.app_id,
        outcome: expect.any(String),
      }),
      expect.any(String),
    );
    expectSafeLogs(f);
  },
);

it('[AC-B1-08i#25] P10 开关关闭仍留待处理与告警，金额照写、状态不迁移', async () => {
  const platforms: string[] = [];
  const f = await scenario(
    db,
    { raw_status: 'received', received_at: at(RECEIVED) },
    {
      regressionHold: (platform) => {
        platforms.push(platform);
        return false;
      },
    },
  );
  expect(
    await f.pipeline.process(f.next({ raw_status: 'paid', est_commission_fen: 555n }), f.ctx),
  ).toMatchObject({ kind: 'updated' });
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({
    platform_status: 'RECEIVED',
    est_commission_fen: 555n,
    row_version: f.original.row_version + 1,
    commission_version: f.original.commission_version + 1,
  });
  expect(after.orders[0]?.content_hash).not.toBe(f.original.content_hash);
  expect(after.history).toEqual(f.before.history);
  expect(after.pending).toEqual([expect.objectContaining({ reason: 'ILLEGAL_TRANSITION' })]);
  expect(platforms).toContain('pdd');
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(f.publishedOf('order.updated')).toHaveLength(1);
  expectAlert(f, 'order.illegal_transition', {
    reason: 'ILLEGAL_TRANSITION',
    from_status: 'RECEIVED',
  });
  expect(f.publishedOf('order.illegal_transition')[0]?.[0]).toBe(
    f.publishedOf('order.updated')[0]?.[0],
  );
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({ rule: 'P10', to_status: 'RECEIVED' });
  expectSafeLogs(f);
});

it.each(['CREDITED', 'CLAWED_BACK'])(
  '[AC-B1-08i#26] 表外码 + %s 整条拒收、不调用 settlement',
  async (rebate) => {
    const f = await scenario(db);
    await db
      .updateTable('orders')
      .set({ rebate_status: rebate })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    const before = await f.read();
    expect(
      await f.pipeline.process(f.next({ raw_status: 'unknown', est_commission_fen: 444n }), f.ctx),
    ).toEqual({ kind: 'pending', order_id: f.original.order_id, reason: 'UNMAPPED_STATUS' });
    const after = await f.read();
    expect(after.orders).toEqual(before.orders);
    expect(after.history).toEqual(before.history);
    expect(after.pending).toEqual([
      expect.objectContaining({
        reason: 'UNMAPPED_STATUS',
        order_id: f.original.order_id,
        raw_status: 'unknown',
        raw_payload_id: 202n,
        detected_at: f.clock.now(),
      }),
    ]);
    expect(f.onUpdated).not.toHaveBeenCalled();
    expect(f.onUnmappedStatus).not.toHaveBeenCalled();
    expect(f.publishedOf('order.updated')).toHaveLength(0);
    expect(f.publishedOf('order.created')).toHaveLength(0);
    expect(f.publishedOf('order.illegal_transition')).toHaveLength(0);
    expectUnmappedAlert(f);
  },
);

it.each(['ESTIMATED', 'WAITING', 'UNATTRIBUTED', 'VOID'])(
  '[AC-B1-08i#27] 表外码 + %s 其余列照写，hold 完全交 settlement 端口',
  async (rebate) => {
    const f = await scenario(db);
    await db
      .updateTable('orders')
      .set({ rebate_status: rebate })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    await f.pipeline.process(f.next({ raw_status: 'unknown', est_commission_fen: 222n }), f.ctx);
    const after = await f.read();
    expect(after.orders[0]).toMatchObject({
      platform_status: 'PAID',
      rebate_status: rebate,
      est_commission_fen: 222n,
      hold: false,
      hold_reason: null,
      rights_pending: false,
    });
    expect(after.history).toEqual(f.before.history);
    expect(after.pending).toEqual([expect.objectContaining({ reason: 'UNMAPPED_STATUS' })]);
    expect(f.onUnmappedStatus).toHaveBeenCalledTimes(1);
    expect(f.onUnmappedStatus.mock.calls[0]?.[1]).toEqual({
      app_id: f.ctx.app_id,
      order_id: f.original.order_id,
      attr_at: f.original.attr_at,
      rebate_status: rebate,
    });
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    expect(f.publishedOf('order.updated')).toHaveLength(1);
    expect(f.publishedOf('order.illegal_transition')).toHaveLength(0);
    expect(f.onUnmappedStatus.mock.calls[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
    expect(f.publishedOf('order.updated')[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
    expectUnmappedAlert(f);
  },
);
