// B1-04zs: a rejected row keeps its content hash, so every rescan round rejects it again. The P1 log
// stays quiet only for a true repeat: the open row of the key already holds this raw_status and
// this detail. Anything else alerts (BR-FUND-02), and the open row changes only in detected_at.
// Events, pending writes and the result are as before.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { OrderUpdateDeps } from '../../../../apps/api/src/modules/orders/index.ts';
import { fixture } from '../attribution/kit.ts';
import { at, RECEIVED, scenario, snapshot } from './kit.ts';

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

type Scenario = Awaited<ReturnType<typeof scenario>>;

function p1Logs(f: Pick<Scenario, 'logger'>) {
  return f.logger.error.mock.calls.filter((call) => {
    const fields = call[0] as Record<string, unknown>;
    return fields['alert'] === 'P1' && fields['event'] === 'order_illegal_transition';
  });
}

/** P10 regression with the hold on: rejected, order.illegal_transition on every pass. */
async function regression() {
  const f = await scenario(db, { raw_status: 'received', received_at: at(RECEIVED) });
  return { f, incoming: f.next({ raw_status: 'paid' }) };
}

/** A status outside the map on a credited order: rejected, no event (08 names none). */
async function unmappedOnCredited() {
  const f = await scenario(db);
  await db
    .updateTable('orders')
    .set({ rebate_status: 'CREDITED' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  return { f, incoming: f.next({ raw_status: 'unknown' }) };
}

it.each([
  { reason: 'ILLEGAL_TRANSITION', arrange: regression, events: 3, eventIds: 2 },
  { reason: 'UNMAPPED_STATUS', arrange: unmappedOnCredited, events: 0, eventIds: 0 },
])(
  '[AC-B1-04zs#4] $reason：同一被拒报文再来只刷新 detected_at、P1 日志仍 1 条；解决后再来新开一行，再打一条',
  async ({ reason, arrange, events, eventIds }) => {
    const { f, incoming } = await arrange();
    const result = await f.pipeline.process(incoming, f.ctx);
    expect(result).toEqual({ kind: 'pending', order_id: f.original.order_id, reason });
    expect(p1Logs(f)).toHaveLength(1);
    const opened = (await f.read()).pending;
    expect(opened).toEqual([
      expect.objectContaining({ reason, status: 'open', detected_at: f.clock.now() }),
    ]);

    f.clock.advanceMs(70_000);
    expect(await f.pipeline.process(incoming, f.ctx)).toEqual(result);
    expect((await f.read()).pending).toEqual(
      opened.map((row) => ({ ...row, detected_at: f.clock.now() })),
    );
    expect(p1Logs(f)).toHaveLength(1);

    await db
      .updateTable('order_sync_pending')
      .set({ status: 'resolved', resolved_at: f.clock.now() })
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    f.clock.advanceMs(70_000);
    expect(await f.pipeline.process(incoming, f.ctx)).toEqual(result);
    const reopened = (await f.read()).pending;
    expect(reopened).toHaveLength(2);
    expect(reopened[0]).toMatchObject({ id: opened[0]?.id, status: 'resolved' });
    expect(reopened[1]).toMatchObject({ reason, status: 'open', detected_at: f.clock.now() });
    expect(reopened[1]?.id).not.toBe(opened[0]?.id);
    expect(p1Logs(f)).toHaveLength(2);

    const alerts = f.publishedOf('order.illegal_transition');
    expect(alerts).toHaveLength(events);
    expect(new Set(alerts.map(([, event]) => event.eventId)).size).toBe(eventIds);
    expect(f.publishedOf('order.updated')).toHaveLength(0);
    expect(f.onUpdated).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zs#5] 已入账单换表外码：不同的码再打一条 P1，存量行仍是原码、只刷新 detected_at；原码再来不打', async () => {
  const { f, incoming } = await unmappedOnCredited();
  const other = f.next({ raw_status: 'unknown-other', raw_payload_id: '303' });
  const result = { kind: 'pending', order_id: f.original.order_id, reason: 'UNMAPPED_STATUS' };

  expect(await f.pipeline.process(incoming, f.ctx)).toEqual(result);
  expect(p1Logs(f)).toHaveLength(1);
  const opened = (await f.read()).pending;
  expect(opened).toEqual([
    expect.objectContaining({ reason: 'UNMAPPED_STATUS', raw_status: 'unknown', status: 'open' }),
  ]);
  const pendingAfterRefresh = () => opened.map((row) => ({ ...row, detected_at: f.clock.now() }));

  f.clock.advanceMs(70_000);
  expect(await f.pipeline.process(other, f.ctx)).toEqual(result);
  expect((await f.read()).pending).toEqual(pendingAfterRefresh());
  expect(p1Logs(f)).toHaveLength(2);

  f.clock.advanceMs(70_000);
  expect(await f.pipeline.process(incoming, f.ctx)).toEqual(result);
  expect((await f.read()).pending).toEqual(pendingAfterRefresh());
  expect(p1Logs(f)).toHaveLength(2);

  // The open row still holds the first code, so the other code is still not a repeat of it.
  f.clock.advanceMs(70_000);
  expect(await f.pipeline.process(other, f.ctx)).toEqual(result);
  expect((await f.read()).pending).toEqual(pendingAfterRefresh());
  expect(p1Logs(f)).toHaveLength(3);

  expect(f.publishedOf('order.illegal_transition')).toHaveLength(0);
  expect(f.onUnmappedStatus).not.toHaveBeenCalled();
  expect(f.onUpdated).not.toHaveBeenCalled();
});

/**
 * RIGHTS has no first state, so the sub-order's first payload is rejected on the first-import path:
 * a pending row without an order, no detail and only a warn. The deposit then imports the order and
 * leaves that row open. The kit's scenario imports first, so this order of events is spelled out.
 */
async function pendingOpenedBeforeImport() {
  const f = await fixture(db, {
    raw_status: 'deposit',
    deposit_paid_at: at('2026-10-14T03:04:05Z'),
    paid_at: null,
  });
  const publish = vi
    .fn<OrderUpdateDeps['events']['publish']>()
    .mockResolvedValue({ eventId: randomUUID(), duplicate: false });
  const updateDeps: OrderUpdateDeps = {
    clock: f.clock,
    users: f.deps.users,
    bindings: f.deps.bindings,
    statusMaps: f.deps.statusMaps,
    rebate: {
      onUpdated: vi.fn<OrderUpdateDeps['rebate']['onUpdated']>().mockResolvedValue(undefined),
      onUnmappedStatus: vi
        .fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>()
        .mockResolvedValue(undefined),
    },
    events: { publish },
    logger: f.logger,
  };
  const updateStep = createOrderUpdateStep(updateDeps);
  const pipeline = createOrderPipeline({ ...f.deps, updateStep });
  const rejected = { ...f.incoming, raw_status: 'rights', raw_payload_id: '202' };
  const read = () => snapshot(db, f.ctx.app_id);

  expect(await pipeline.process(rejected, f.ctx)).toEqual({
    kind: 'pending',
    reason: 'ILLEGAL_TRANSITION',
  });
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'ILLEGAL_TRANSITION', outcome: 'pending' }),
    expect.any(String),
  );
  const opened = (await read()).pending;
  expect(opened).toEqual([
    expect.objectContaining({
      reason: 'ILLEGAL_TRANSITION',
      raw_status: 'rights',
      order_id: null,
      detail: null,
      status: 'open',
    }),
  ]);

  expect(await pipeline.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const orderId = (await read()).orders[0]?.order_id;
  expect(orderId).toEqual(expect.any(String));
  expect((await read()).pending).toEqual(opened);
  return { f, pipeline, rejected, read, opened, orderId };
}

it('[AC-B1-04zs#6] 同键 open 由首次入库路径开（只有 warn、detail 为空）：reject 同一个码不算重复，要打 P1；解决后 reject 自己开的行再来才不打', async () => {
  const { f, pipeline, rejected, read, opened, orderId } = await pendingOpenedBeforeImport();
  const result = { kind: 'pending', order_id: orderId, reason: 'ILLEGAL_TRANSITION' };
  expect(p1Logs(f)).toHaveLength(0);

  f.clock.advanceMs(70_000);
  expect(await pipeline.process(rejected, f.ctx)).toEqual(result);
  expect((await read()).pending).toEqual(
    opened.map((row) => ({ ...row, detected_at: f.clock.now() })),
  );
  expect(p1Logs(f)).toHaveLength(1);

  await db
    .updateTable('order_sync_pending')
    .set({ status: 'resolved', resolved_at: f.clock.now() })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(70_000);
  expect(await pipeline.process(rejected, f.ctx)).toEqual(result);
  const reopened = (await read()).pending;
  expect(reopened).toHaveLength(2);
  expect(reopened[1]).toMatchObject({
    reason: 'ILLEGAL_TRANSITION',
    raw_status: 'rights',
    order_id: orderId,
    detail: 'order_illegal_transition illegal DEPOSIT_PAID→PLATFORM_RIGHTS',
    status: 'open',
  });
  expect(p1Logs(f)).toHaveLength(2);

  f.clock.advanceMs(70_000);
  expect(await pipeline.process(rejected, f.ctx)).toEqual(result);
  expect((await read()).pending).toEqual([
    reopened[0],
    { ...reopened[1], detected_at: f.clock.now() },
  ]);
  expect(p1Logs(f)).toHaveLength(2);
});
