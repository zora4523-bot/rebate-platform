import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  fixture,
  assertAlert,
  observePublication,
  capture,
  HOUR,
  HANDOFF,
  realBus,
  eventRows,
  expectedEvent,
  succeed,
  splits,
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

it.each(['pipeline', 'scan'] as const)(
  '[AC-B1-08u#2] %s 在标记后以同一事务发四字段告警，重入不再发，保留冗余日志',
  async (path) => {
    const f = await fixture(db, path);
    // 新插入但时间更早的快照行才是告警定位行；排除已处置行与非快照行。
    const first = (await f.pending())[0]!;
    await f.addPending({
      reason: 'NO_RECEIVED_AT',
      created_at: new Date(first.created_at.getTime() - 3 * HOUR),
    });
    await f.addPending({
      reason: 'SERVICE_FEE_RATE_MISSING',
      status: 'resolved',
      created_at: new Date(first.created_at.getTime() - 2 * HOUR),
    });
    await f.addPending({
      reason: 'AMOUNT_PARSE_FAILED',
      created_at: new Date(first.created_at.getTime() - HOUR),
    });
    const before = await f.pending();
    const earliest = before.find((row) => row.reason === 'AMOUNT_PARSE_FAILED')!;
    const seen = observePublication(f, db);
    f.clock.advanceMs(24 * HOUR);
    expect(
      await capture<unknown>(() => (path === 'pipeline' ? f.process(f.next()) : f.scan())),
    ).toMatchObject({ ok: true });
    const { trx } = assertAlert(f, earliest);
    expect(trx).toBe(f.port.create.mock.calls[0]?.[0]);
    if (path === 'pipeline') expect(trx).toBe(f.onUpdated.mock.calls[0]?.[0]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outside).toEqual(before);
    for (const row of seen[0]!.inside) {
      const old = before.find((p) => p.id === row.id)!;
      if (row.status === 'open' && row.reason !== 'NO_RECEIVED_AT') {
        expect(row).toMatchObject({
          resolution_note: HANDOFF,
          status: 'open',
          resolved_at: old.resolved_at,
          resolved_by: old.resolved_by,
          created_at: old.created_at,
        });
      } else expect(row).toEqual(old);
    }
    expect(await f.pending()).toEqual(seen[0]?.inside);
    expect(f.alerts()).toHaveLength(1);
    f.clock.advanceMs(2 * HOUR);
    await f.scan();
    await f.process(f.next());
    expect(f.events()).toHaveLength(1);
    expect(f.port.create).toHaveBeenCalledTimes(1);
    expect(f.alerts()).toHaveLength(1);
  },
);

it('[AC-B1-08u#3] 满24小时端口写后抛错：原事务回滚，另起标记事务发一次事件', async () => {
  const f = await fixture(db);
  const port = await succeed(f, db);
  const before = await f.pending();
  const failure = new Error('synthetic snapshot port failure');
  f.port.create.mockImplementation(async (trx, input) => {
    await port.create(trx, input);
    throw failure;
  });
  const seen = observePublication(f, db);
  f.clock.advanceMs(24 * HOUR);
  expect(await capture(() => f.scan())).toMatchObject({ ok: true });
  const { trx } = assertAlert(f, before[0]!);
  expect(trx).not.toBe(f.port.create.mock.calls[0]?.[0]);
  expect(seen[0]?.outside).toEqual(before);
  expect(seen[0]?.inside).toEqual([
    expect.objectContaining({ resolution_note: HANDOFF, status: 'open', resolved_at: null }),
  ]);
  expect(await f.pending()).toEqual(seen[0]?.inside);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  f.clock.advanceMs(2 * HOUR);
  await f.scan();
  await f.process(f.next());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.events()).toHaveLength(1);
  expect(f.alerts()).toHaveLength(1);
});

it.each(['pipeline', 'scan', 'error'] as const)(
  '[AC-B1-08u#4] %s 真实 EventBus 提交才可见，同 eventId 重发 duplicate 且只一行',
  async (path) => {
    const f = await fixture(db, path === 'pipeline' ? 'pipeline' : 'scan');
    const pending = (await f.pending())[0]!;
    const { bus, send } = realBus(f);
    const seen = observePublication(f, db, bus);
    if (path === 'error') f.port.create.mockRejectedValue(new Error('synthetic port failure'));
    f.clock.advanceMs(24 * HOUR);
    expect(
      await capture<unknown>(() => (path === 'pipeline' ? f.process(f.next()) : f.scan())),
    ).toMatchObject({ ok: true });
    assertAlert(f, pending);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ insideEvents: 1, outsideEvents: 0 });
    expect(seen[0]?.outside[0]?.resolution_note).toBe(pending.resolution_note);
    expect(seen[0]?.inside[0]?.resolution_note).toBe(HANDOFF);
    const event = expectedEvent(f, pending);
    const committed = await eventRows(db, f.ctx.app_id);
    expect(committed).toEqual([
      expect.objectContaining({
        app_id: f.ctx.app_id,
        name: event.name,
        event_id: event.eventId,
        payload: { v: 1, data: event.payload },
        occurred_at: f.clock.now(),
      }),
    ]);
    const duplicate = await capture(() =>
      db.transaction().execute((trx) => bus.publish(trx, event)),
    );
    expect(duplicate).toEqual({ ok: true, value: { eventId: event.eventId, duplicate: true } });
    expect(await eventRows(db, f.ctx.app_id)).toEqual(committed);
    expect(send).not.toHaveBeenCalled();
    f.clock.advanceMs(2 * HOUR);
    await f.scan();
    await f.process(f.next());
    expect(f.events()).toHaveLength(1);
    expect(await eventRows(db, f.ctx.app_id)).toEqual(committed);
  },
);
