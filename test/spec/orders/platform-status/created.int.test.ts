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
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/index.ts';
import type { EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import { capture, fixture, snapshot } from '../attribution/kit.ts';

it('[AC-B1-08i#43] 可选 events 注入后首次入库同事务发 order.created，重复不重发', async () => {
  const f = await fixture(db);
  const publish = vi.fn<EventBus['publish']>().mockImplementation(async (trx, event) => {
    expect(trx.isTransaction).toBe(true);
    expect(trx).toBe(f.onImported.mock.calls[0]?.[0]);
    const rows = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(event).toEqual({
      appId: f.ctx.app_id,
      name: 'order.created',
      payload: {
        order_id: rows[0]?.order_id,
        platform: 'pdd',
        platform_status: 'PAID',
        attributed: true,
      },
    });
    expect((await snapshot(db, f.ctx.app_id)).orders).toEqual([]);
    return { eventId: randomUUID(), duplicate: false };
  });
  const pipeline = createOrderPipeline({ ...f.deps, events: { publish } });
  const result = await capture(() => pipeline.process(f.incoming, f.ctx));
  expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(publish).toHaveBeenCalledTimes(1);
  f.clock.advanceMs(100_000);
  const duplicate = await capture(() =>
    pipeline.process({ ...f.incoming, raw_payload_id: '202' }, f.ctx),
  );
  expect(duplicate).toMatchObject({ ok: true, value: { kind: 'unchanged' } });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('[AC-B1-08i#44] order.created 入队失败回滚首次订单与归因产物', async () => {
  const f = await fixture(db);
  const before = await snapshot(db, f.ctx.app_id);
  const failure = new Error('synthetic-created-failure');
  const publish = vi.fn<EventBus['publish']>().mockRejectedValue(failure);
  const pipeline = createOrderPipeline({ ...f.deps, events: { publish } });
  const result = await capture(() => pipeline.process(f.incoming, f.ctx));
  expect(result).toEqual({ ok: false, error: failure });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
});
