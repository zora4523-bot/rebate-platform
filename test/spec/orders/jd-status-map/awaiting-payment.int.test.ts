import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { isAwaitingPaymentDrop } from '../../../../apps/api/src/modules/orders/domain/jd-status.ts';
import { fixture, pipeline, snapshot } from '../attribution/kit.ts';
import { jdFixture, warnFields } from './pipeline-kit.ts';

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

it('[AC-B1-04zg#12] BR-ATTR-25：京东 15 照记 NO_PAY_TIME 丢弃，不写 warn，重复只计一次', async () => {
  const f = await jdFixture(db, { raw_status: '15', paid_at: null });
  const p = await pipeline(f.deps);
  const dropped = { kind: 'dropped', reason: 'NO_PAY_TIME' };
  expect(await p.process(f.incoming, f.ctx)).toEqual(dropped);
  f.clock.advanceMs(86_400_000);
  expect(await p.process(f.incoming, f.ctx)).toEqual(dropped);
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.keys).toEqual([]);
  expect(s.orders).toEqual([]);
  expect(s.history).toEqual([]);
  expect(s.pending).toEqual([]);
  expect(s.counters).toEqual([]);
  expect(s.dropKeys).toEqual([
    expect.objectContaining({
      platform: 'jd',
      sub_order_id: f.incoming.sub_order_id,
      reason: 'NO_PAY_TIME',
    }),
  ]);
  expect(s.drops).toEqual([
    expect.objectContaining({
      platform: 'jd',
      reason: 'NO_PAY_TIME',
      count: 1n,
      day: '2026-10-18',
    }),
  ]);
  expect(f.findUser).not.toHaveBeenCalled();
  expect(f.onImported).not.toHaveBeenCalled();
  expect(f.logger.warn).not.toHaveBeenCalled();
  expect(f.logger.error).not.toHaveBeenCalled();
});

it.each([
  ['jd', '16'],
  ['jd', '14'],
  ['jd', null],
  ['pdd', '15'],
  ['taobao', '15'],
] as const)(
  '[AC-B1-04zg#13] BR-ATTR-25：%s 的 %s 两时间都空照旧 warn',
  async (platform, rawStatus) => {
    // 骨架上先红：判定函数与流水线同口径，流水线这条路今天本来就 warn。
    expect(isAwaitingPaymentDrop(platform, rawStatus)).toBe(false);
    const f = await fixture(db, { platform, raw_status: rawStatus, paid_at: null });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toEqual({ kind: 'dropped', reason: 'NO_PAY_TIME' });
    expect(warnFields(f.logger, 'NO_PAY_TIME')).toEqual([
      { platform, app_id: f.ctx.app_id, reason: 'NO_PAY_TIME', outcome: 'dropped' },
    ]);
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.drops).toEqual([
      expect.objectContaining({ platform, reason: 'NO_PAY_TIME', count: 1n }),
    ]);
  },
);
