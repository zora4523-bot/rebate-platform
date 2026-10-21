import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fixture,
  assertAlert,
  capture,
  HOUR,
  HANDOFF,
  ALERT,
  realBus,
  eventRows,
  expectedEvent,
} from './kit.ts';

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

it('[AC-B1-08u#5] 流水线 publish 抛错传出，订单更新、转人工标记和事件一起回滚，下次可重试', async () => {
  const f = await fixture(db, 'pipeline');
  const { bus } = realBus(f);
  const pending = (await f.pending())[0]!;
  const before = await f.read();
  const failure = new Error('synthetic enqueue failure');
  const inside: unknown[] = [];
  f.publish.mockImplementation(async (trx, event) => {
    const result = await bus.publish(trx, event);
    if (event.name === ALERT) {
      inside.push({
        events: (await eventRows(trx, f.ctx.app_id)).length,
        pending: await trx
          .withSchema('app')
          .selectFrom('order_sync_pending')
          .selectAll()
          .where('app_id', '=', f.ctx.app_id)
          .execute(),
      });
      throw failure;
    }
    return result;
  });
  f.clock.advanceMs(24 * HOUR);
  const incoming = f.next();
  expect(await capture(() => f.process(incoming))).toEqual({ ok: false, error: failure });
  assertAlert(f, pending);
  expect(inside).toEqual([
    { events: 1, pending: [expect.objectContaining({ resolution_note: HANDOFF })] },
  ]);
  expect(await f.read()).toEqual(before);
  expect(await eventRows(db, f.ctx.app_id)).toEqual([]);
  expect(f.alerts()).toEqual([]);
  f.publish.mockClear();
  f.publish.mockImplementation((trx, event) => bus.publish(trx, event));
  expect(await capture(() => f.process(incoming))).toMatchObject({ ok: true });
  assertAlert(f, pending);
  expect(await eventRows(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.resolution_note).toBe(HANDOFF);
});

it('[AC-B1-08u#6] 下游失败不能留下事件或转人工标记，恢复后原报文可重新告警', async () => {
  const f = await fixture(db, 'pipeline');
  const { bus } = realBus(f);
  f.publish.mockImplementation((trx, event) => bus.publish(trx, event));
  const before = await f.read();
  const pending = (await f.pending())[0]!;
  const failure = new Error('synthetic settlement failure');
  f.onUpdated.mockRejectedValue(failure);
  f.clock.advanceMs(24 * HOUR);
  const incoming = f.next();
  expect(await capture(() => f.process(incoming))).toEqual({ ok: false, error: failure });
  expect(await f.read()).toEqual(before);
  expect(await eventRows(db, f.ctx.app_id)).toEqual([]);
  expect(f.alerts()).toEqual([]);
  f.publish.mockClear();
  f.onUpdated.mockResolvedValue(undefined);
  expect(await capture(() => f.process(incoming))).toMatchObject({ ok: true });
  assertAlert(f, pending);
  expect(await eventRows(db, f.ctx.app_id)).toHaveLength(1);
});

it.each(['pending', 'port-error'] as const)(
  '[AC-B1-08u#7] 扫描 %s 首单入队失败只回滚该单，后一单仍提交，下轮首单可再试',
  async (mode) => {
    const f = await fixture(db);
    const secondIncoming = { ...f.incoming, sub_order_id: randomUUID() };
    f.clock.advanceMs(1000);
    expect(await capture(() => f.process(secondIncoming))).toMatchObject({ ok: true });
    // 首次发现时间按 Clock 固定；第一单 detected_at 更早，确保真实扫描顺序。
    await db
      .withSchema('app')
      .updateTable('order_sync_pending')
      .set({ created_at: f.clock.now() })
      .where('app_id', '=', f.ctx.app_id)
      .where('sub_order_id', '=', secondIncoming.sub_order_id)
      .execute();
    const before = await f.pending();
    const second = before.find((p) => p.sub_order_id === secondIncoming.sub_order_id)!;
    const beforeOrders = (await f.read()).orders;
    const { bus } = realBus(f);
    let fail = true;
    const failure = new Error('synthetic first order enqueue failure');
    f.publish.mockClear();
    f.publish.mockImplementation(async (trx, event) => {
      const result = await bus.publish(trx, event);
      if (event.name === ALERT && event.payload.order_id === f.current.order_id && fail) {
        // 一次性失败：不能被 catch 当作快照端口失败，另起 handoff 事务立刻再发。
        fail = false;
        throw failure;
      }
      return result;
    });
    f.port.create.mockClear();
    if (mode === 'port-error') {
      f.port.create.mockImplementation(async (_trx, input) => {
        if (input.orderId === f.current.order_id) throw new Error('synthetic port failure');
        return { kind: 'pending', reason: 'missing platform rule' };
      });
    }
    f.clock.advanceMs(24 * HOUR);
    expect(await capture(() => f.scan())).toMatchObject({ ok: true });
    expect(f.port.create.mock.calls.map(([, input]) => input.orderId)).toEqual([
      f.current.order_id,
      second.order_id,
    ]);
    expect(f.events().map(([, event]) => event.payload.order_id)).toEqual([
      f.current.order_id,
      second.order_id,
    ]);
    const after = await f.pending();
    expect(after.find((p) => p.id === before[0]!.id)).toEqual(before[0]);
    expect(after.find((p) => p.id === second.id)).toMatchObject({
      status: 'open',
      resolution_note: HANDOFF,
      resolved_at: null,
    });
    expect((await f.read()).orders).toEqual(beforeOrders);
    expect(await eventRows(db, f.ctx.app_id)).toEqual([
      expect.objectContaining({
        payload: {
          v: 1,
          data: {
            order_id: second.order_id,
            pending_id: second.id.toString(),
            platform: 'jd',
            reason: second.reason,
          },
        },
      }),
    ]);
    const errors = f.logger.error.mock.calls.map(([fields]) => fields as Record<string, unknown>);
    expect(errors).toContainEqual(
      expect.objectContaining({ event: 'snapshot_retry_failed', outcome: 'rolled_back' }),
    );
    f.publish.mockClear();
    // 失败事务不刷新 detected_at：不用推进时钟，下轮即可再试。
    expect(await capture(() => f.scan())).toMatchObject({ ok: true });
    assertAlert(f, before[0]!);
    expect((await f.pending()).every((p) => p.resolution_note === HANDOFF)).toBe(true);
    expect(await eventRows(db, f.ctx.app_id)).toHaveLength(2);
    const original = expectedEvent(f, before[0]!);
    expect(await db.transaction().execute((trx) => bus.publish(trx, original))).toEqual({
      eventId: original.eventId,
      duplicate: true,
    });
  },
);

it('[AC-B1-08u#8] 流水线与扫描并发争同一订单锁，只发布和留痕一次', async () => {
  const f = await fixture(db);
  const pending = (await f.pending())[0]!;
  const { bus } = realBus(f);
  f.publish.mockImplementation((trx, event) => bus.publish(trx, event));
  f.clock.advanceMs(24 * HOUR);
  const incoming = f.next();
  expect(await capture(() => Promise.all([f.scan(), f.process(incoming), f.scan()]))).toMatchObject(
    { ok: true },
  );
  assertAlert(f, pending);
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await eventRows(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.resolution_note).toBe(HANDOFF);
  expect(f.alerts()).toHaveLength(1);
});
