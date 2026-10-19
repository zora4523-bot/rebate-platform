import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readSnapshotRetryInput } from '../../../../apps/api/src/modules/orders/index.ts';
import { at } from '../attribution/kit.ts';
import { setupScan, succeed, capture, HOUR } from './kit.ts';

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

it.each([
  { settled: 901n, estimated: 789n, expected: 901n },
  { settled: 0n, estimated: 789n, expected: 0n },
  { settled: null, estimated: 789n, expected: 789n },
])('[AC-B1-08t#28] 扫描恢复佣金基数：结算=$settled，预估=$estimated', async (amount) => {
  const f = await setupScan(db, {
    est_commission_fen: amount.estimated,
  });
  // 首次入库不写结算佣金；显式布置已经持久化的结算值，再交给恢复函数。
  await db
    .updateTable('orders')
    .set({ settle_commission_fen: amount.settled })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  const row = (await f.read()).orders[0]!;
  await succeed(f, db);
  f.clock.advanceMs(HOUR);
  const result = await capture(() =>
    db.transaction().execute((trx) => readSnapshotRetryInput(trx, row, f.clock)),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { kind: 'call', input: { nBaseFen: amount.expected, paidAt: f.current.paid_at } },
  });
  expect(await capture(() => f.scan())).toMatchObject({ ok: true });
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({ nBaseFen: amount.expected });
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it('[AC-B1-08t#29] observed 从数据库首条 PAID 历史恢复 paidAt，不取付款列、最新历史或 now', async () => {
  const f = await setupScan(db);
  const firstPaidAt = at('2026-10-17T15:30:00.000Z');
  await db
    .updateTable('orders')
    .set({ paid_at_source: 'observed' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  // 插入顺序也不是时间顺序：已有 PAID 的 id 更小，但 at 更晚。
  await db
    .insertInto('order_status_history')
    .values([
      {
        app_id: f.ctx.app_id,
        order_id: f.current.order_id,
        field: 'platform',
        from_status: 'DEPOSIT_PAID',
        to_status: 'PAID',
        event: 'PLATFORM_PAID',
        source: 'sync',
        at: firstPaidAt,
        created_at: f.clock.now(),
      },
      {
        app_id: f.ctx.app_id,
        order_id: f.current.order_id,
        field: 'platform',
        from_status: 'PAID',
        to_status: 'PAID',
        event: 'PLATFORM_PAID',
        source: 'sync',
        at: at('2026-10-17T18:00:00.000Z'),
        created_at: f.clock.now(),
      },
    ])
    .execute();
  const row = (await f.read()).orders[0]!;
  await succeed(f, db);
  f.clock.advanceMs(2 * HOUR);
  const result = await capture(() =>
    db.transaction().execute((trx) => readSnapshotRetryInput(trx, row, f.clock)),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { kind: 'call', input: { paidAt: firstPaidAt, paidAtSource: 'observed' } },
  });
  expect(await capture(() => f.scan())).toMatchObject({ ok: true });
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: firstPaidAt,
    paidAtSource: 'observed',
  });
  expect((await f.read()).orders[0]).toMatchObject({
    paid_at: row.paid_at,
    paid_at_source: 'observed',
    rebate_status: row.rebate_status,
    hold: row.hold,
    hold_reason: row.hold_reason,
  });
});

it('[AC-B1-08t#30] platform_modified 的首次迁移时刻不可恢复，扫描跳过并 warn', async () => {
  const depositAt = at('2026-10-15T16:00:00.000Z');
  const f = await setupScan(db, {
    paid_at: depositAt,
    deposit_paid_at: depositAt,
  });
  expect(f.current.paid_at_source).toBe('platform_modified');
  f.clock.advanceMs(HOUR);
  const before = await f.read();
  f.logger.warn.mockClear();
  const result = await capture(() =>
    db.transaction().execute((trx) => readSnapshotRetryInput(trx, f.current, f.clock)),
  );
  expect(result).toMatchObject({ ok: true, value: { kind: 'skip' } });
  expect(await capture(() => f.scan())).toMatchObject({ ok: true });
  expect(f.port.create).not.toHaveBeenCalled();
  expect(await f.read()).toEqual(before);
  const warnings = f.logger.warn.mock.calls.map(([fields]) => fields as Record<string, unknown>);
  expect(warnings).toContainEqual(
    expect.objectContaining({
      event: 'snapshot_retry_skipped',
      app_id: f.ctx.app_id,
      platform: 'jd',
      reason: expect.any(String),
    }),
  );
  for (const fields of warnings) {
    expect(
      Object.values(fields).every((value) => value === null || typeof value !== 'object'),
    ).toBe(true);
    expect(JSON.stringify(fields)).not.toContain(f.incoming.sub_order_id);
    expect(JSON.stringify(fields)).not.toContain(f.userId);
  }
});
