import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupScan, succeed, splits, capture, HOUR } from './kit.ts';

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

it('[AC-B1-08t#27] 同 App 扫描首单抛错只回滚该单，后一张到期京东单仍处置成功', async () => {
  const f = await setupScan(db);
  const secondIncoming = { ...f.incoming, sub_order_id: randomUUID() };
  f.clock.advanceMs(1000);
  expect(await capture(() => f.process(secondIncoming))).toMatchObject({ ok: true });
  // 两单共用 App、账户与用户；第一单的 detected_at 更早，必须先尝试它。
  const pendingBefore = await f.pending();
  expect(pendingBefore).toHaveLength(2);
  const secondPending = pendingBefore.find((p) => p.sub_order_id === secondIncoming.sub_order_id)!;
  const port = await succeed(f, db);
  f.port.create.mockClear();
  f.port.create.mockImplementation(async (trx, input) => {
    const result = await port.create(trx, input);
    if (input.orderId === f.current.order_id) throw new Error('synthetic first order failure');
    return result;
  });
  f.clock.advanceMs(HOUR);
  f.logger.error.mockClear();
  expect(await capture(() => f.scan())).toMatchObject({ ok: true });
  expect(f.port.create.mock.calls.map(([, input]) => input.orderId)).toEqual([
    f.current.order_id,
    secondPending.order_id,
  ]);
  const after = await f.pending();
  expect(after.find((p) => p.order_id === f.current.order_id)).toEqual(pendingBefore[0]);
  expect(after.find((p) => p.id === secondPending.id)).toMatchObject({
    status: 'resolved',
    resolved_at: f.clock.now(),
    resolved_by: null,
    resolution_note: 'auto: commission snapshot created',
  });
  expect(await splits(db, f.ctx.app_id)).toEqual([
    expect.objectContaining({ order_id: secondPending.order_id }),
  ]);
  const errors = f.logger.error.mock.calls.map(([fields]) => fields as Record<string, unknown>);
  expect(errors).not.toHaveLength(0);
  expect(errors).toContainEqual(expect.objectContaining({ app_id: f.ctx.app_id, platform: 'jd' }));
  for (const fields of errors) {
    expect(
      Object.values(fields).every((value) => value === null || typeof value !== 'object'),
    ).toBe(true);
    expect(JSON.stringify(fields)).not.toContain(f.incoming.sub_order_id);
    expect(JSON.stringify(fields)).not.toContain(secondIncoming.sub_order_id);
    expect(JSON.stringify(fields)).not.toContain(f.userId);
  }
});
