import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
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
import { at, expectAlert, RECEIVED, scenario } from './kit.ts';

it('[AC-B1-08i#40] 端口在同一事务看到 UPDATE、history、pending，且 rebate 先于事件', async () => {
  const f = await scenario(db, {
    raw_status: 'deposit',
    deposit_paid_at: at('2026-10-14T08:09:10Z'),
    paid_at: null,
  });
  const order: string[] = [];
  const connections: unknown[] = [];
  f.onUpdated.mockImplementation(async (trx, change) => {
    order.push('rebate');
    connections.push(trx);
    expect(trx.isTransaction).toBe(true);
    const row = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      est_commission_fen: 456n,
      row_version: f.original.row_version + 1,
    });
    const pending = await trx
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    expect(pending).toEqual([expect.objectContaining({ reason: 'NO_RECEIVED_AT' })]);
    expect(change.received_at).toBeNull();
    const history = await trx
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .orderBy('id')
      .execute();
    expect(history.slice(f.before.history.length)).toEqual([
      expect.objectContaining({
        from_status: 'DEPOSIT_PAID',
        to_status: 'PAID',
        event: 'PLATFORM_PAID',
      }),
    ]);
    // Another connection still sees only the committed old order and no pending.
    expect(await f.read()).toEqual(f.before);
  });
  f.publish.mockImplementation(async (trx, event) => {
    if (event.name !== 'order.updated') return { eventId: randomUUID(), duplicate: false };
    order.push('event');
    connections.push(trx);
    expect(event.name).toBe('order.updated');
    expect(
      await trx
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', f.ctx.app_id)
        .execute(),
    ).toHaveLength(1);
    return { eventId: randomUUID(), duplicate: false };
  });
  await f.pipeline.process(f.next({ raw_status: 'received', est_commission_fen: 456n }), f.ctx);
  expect(order).toEqual(['rebate', 'event']);
  const writes = f.queries.flatMap(({ sql }) => {
    const match =
      /^(?:update|insert into) "app"\."(orders|order_status_history|order_sync_pending)"/i.exec(
        sql,
      );
    return match ? [match[1]] : [];
  });
  expect(writes).toEqual(['orders', 'order_status_history', 'order_sync_pending']);
  expect(connections[0]).toBe(connections[1]);
  expect((await f.read()).pending).toHaveLength(1);
});

it('[AC-B1-08i#41] 状态 history 在 settlement 前写入且其他连接提交前不可见', async () => {
  const f = await scenario(db);
  f.onUpdated.mockImplementation(async (trx) => {
    const history = await trx
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .orderBy('id')
      .execute();
    expect(history.slice(f.before.history.length)).toEqual([
      expect.objectContaining({
        from_status: 'PAID',
        to_status: 'RECEIVED',
        event: 'PLATFORM_RECEIVED',
        at: f.clock.now(),
      }),
    ]);
    expect((await f.read()).history).toEqual(f.before.history);
  });
  await f.pipeline.process(f.next({ raw_status: 'received', received_at: at(RECEIVED) }), f.ctx);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(f.publishedOf('order.updated')[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
});

it.each(['rebate', 'events', 'unmapped'] as const)(
  '[AC-B1-08i#42] %s 端口失败整事务回滚，包括本次 history / pending',
  async (failure) => {
    const f = await scenario(db);
    const error = new Error('synthetic-port-failure');
    const reject = async () => {
      throw error;
    };
    if (failure === 'rebate') f.onUpdated.mockImplementation(reject);
    if (failure === 'unmapped') f.onUnmappedStatus.mockImplementation(reject);
    if (failure === 'events')
      f.publish.mockImplementation(async (trx) => {
        // Transactional port side effect must roll back too, not just the order UPDATE.
        await trx
          .insertInto('order_sync_pending')
          .values({
            app_id: f.ctx.app_id,
            platform: 'pdd',
            sub_order_id: f.original.sub_order_id,
            order_id: f.original.order_id,
            reason: 'NO_RECEIVED_AT',
            status: 'open',
            detected_at: f.clock.now(),
          })
          .execute();
        throw error;
      });
    await expect(
      f.pipeline.process(
        f.next({
          raw_status: failure === 'unmapped' ? 'unknown' : 'received',
          received_at: at(RECEIVED),
          est_commission_fen: 555n,
        }),
        f.ctx,
      ),
    ).rejects.toBe(error);
    expect(await f.read()).toEqual(f.before);
    if (failure !== 'events') expect(f.publishedOf('order.updated')).toHaveLength(0);
    else {
      expect(f.onUpdated).toHaveBeenCalledTimes(1);
      expect(f.publishedOf('order.updated')).toHaveLength(1);
    }
  },
);

it.each([
  { initial: 'received', raw: 'paid', regressionHold: true, fail: false },
  { initial: 'received', raw: 'paid', regressionHold: true, fail: true },
  { initial: 'deposit', raw: 'rights', regressionHold: true, fail: false },
  { initial: 'deposit', raw: 'rights', regressionHold: true, fail: true },
  { initial: 'received', raw: 'paid', regressionHold: false, fail: false },
  { initial: 'received', raw: 'paid', regressionHold: false, fail: true },
])(
  '[AC-B1-08i#45] $initial + $raw，hold=$regressionHold，告警与 pending 同事务提交或回滚（失败=$fail）',
  async ({ initial, raw, regressionHold, fail }) => {
    const f = await scenario(
      db,
      {
        raw_status: initial,
        ...(initial === 'received'
          ? { received_at: at(RECEIVED) }
          : { deposit_paid_at: at('2026-10-14T03:04:05Z'), paid_at: null }),
      },
      { regressionHold: () => regressionHold },
    );
    const failure = new Error('synthetic-alert-failure');
    const readEvents = () =>
      db.selectFrom('event_log').selectAll().where('app_id', '=', f.ctx.app_id).execute();
    f.publish.mockImplementation(async (trx, event) => {
      expect(trx.isTransaction).toBe(true);
      const pending = await trx
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', f.ctx.app_id)
        .execute();
      expect(pending).toEqual([
        expect.objectContaining({
          order_id: f.original.order_id,
          reason: 'ILLEGAL_TRANSITION',
        }),
      ]);
      // A transactional event-port write must share the pending row's commit/rollback.
      const eventId = randomUUID();
      await trx
        .insertInto('event_log')
        .values({
          app_id: event.appId,
          event_id: eventId,
          name: event.name,
          payload: sql`${JSON.stringify(event.payload)}::jsonb`,
          occurred_at: f.clock.now(),
          created_at: f.clock.now(),
        })
        .execute();
      expect(
        await trx
          .selectFrom('event_log')
          .selectAll()
          .where('app_id', '=', f.ctx.app_id)
          .where('name', '=', event.name)
          .execute(),
      ).toHaveLength(1);
      expect(await f.read()).toEqual(f.before);
      expect(await readEvents()).toEqual([]);
      if (event.name === 'order.illegal_transition' && fail) throw failure;
      return { eventId, duplicate: false };
    });
    const result = f.pipeline.process(f.next({ raw_status: raw, est_commission_fen: 555n }), f.ctx);
    if (fail) {
      await expect(result).rejects.toBe(failure);
      expect(await f.read()).toEqual(f.before);
      expect(await readEvents()).toEqual([]);
    } else {
      await expect(result).resolves.toMatchObject({ kind: regressionHold ? 'pending' : 'updated' });
      expect((await f.read()).pending).toEqual([
        expect.objectContaining({
          order_id: f.original.order_id,
          reason: 'ILLEGAL_TRANSITION',
        }),
      ]);
      const events = await readEvents();
      expect(events.filter((event) => event.name === 'order.illegal_transition')).toHaveLength(1);
      expect(events.filter((event) => event.name === 'order.updated')).toHaveLength(
        regressionHold ? 0 : 1,
      );
    }
    expectAlert(f, 'order.illegal_transition', { reason: 'ILLEGAL_TRANSITION' });
    expect(f.publishedOf('order.created')).toHaveLength(0);
    if (regressionHold) {
      expect(f.publishedOf('order.updated')).toHaveLength(0);
      expect(f.onUpdated).not.toHaveBeenCalled();
    } else if (!fail) {
      expect(f.publishedOf('order.updated')).toHaveLength(1);
      expect(f.publishedOf('order.illegal_transition')[0]?.[0]).toBe(
        f.publishedOf('order.updated')[0]?.[0],
      );
    }
  },
);
