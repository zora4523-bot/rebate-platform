import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, ATTR, NOW, fixture, pipeline, snapshot } from './kit.ts';

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

it.each(['PID_NOT_OURS', 'NO_PAY_TIME', 'BEFORE_SYNC_START'])(
  '[AC-B1-08h#29] %s 不建两表，重复丢弃只计一次且使用 +08 日期',
  async (reason) => {
    const f = await fixture(db);
    if (reason === 'PID_NOT_OURS') f.findPid.mockResolvedValue([]);
    if (reason === 'BEFORE_SYNC_START')
      f.syncStartAt.mockResolvedValue(at('2026-10-15T16:00:00.001Z'));
    const input = reason === 'NO_PAY_TIME' ? { ...f.incoming, paid_at: null } : f.incoming;
    const p = await pipeline(f.deps);
    expect(await p.process(input, f.ctx)).toMatchObject({ kind: 'dropped', reason });
    const before = await snapshot(db, f.ctx.app_id);
    f.clock.advanceMs(86_400_000);
    expect(await p.process(input, f.ctx)).toMatchObject({ kind: 'dropped', reason });
    expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
    expect(before.keys).toEqual([]);
    expect(before.orders).toEqual([]);
    expect(before.history).toEqual([]);
    expect(before.pending).toEqual([]);
    expect(before.counters).toEqual([]);
    expect(before.dropKeys).toEqual([
      expect.objectContaining({ platform: 'pdd', sub_order_id: input.sub_order_id, reason }),
    ]);
    expect(before.drops).toEqual([
      expect.objectContaining({
        app_id: f.ctx.app_id,
        platform: 'pdd',
        reason,
        count: 1n,
        day: reason === 'NO_PAY_TIME' ? '2026-10-18' : '2026-10-16',
      }),
    ]);
    expect(f.findUser).not.toHaveBeenCalled();
    expect(f.onImported).not.toHaveBeenCalled();
    if (reason === 'NO_PAY_TIME') expect(f.logger.warn).toHaveBeenCalled();
  },
);

it('[AC-B1-08h#30] 无推广位先于无付款时间；缺付款时间的丢弃按 Clock 日期计数', async () => {
  const f = await fixture(db, { promotion_slot: null, paid_at: null });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({
    kind: 'dropped',
    reason: 'PID_NOT_OURS',
  });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.drops).toEqual([
    expect.objectContaining({ reason: 'PID_NOT_OURS', day: '2026-10-18', count: 1n }),
  ]);
  expect(f.findPid).not.toHaveBeenCalled();
  expect(f.syncStartAt).not.toHaveBeenCalled();
});

it('[AC-B1-08h#31] sync_start_at 缺失以及定金早于起点均丢弃，不借尾款时点', async () => {
  const f = await fixture(db, { deposit_paid_at: at('2026-09-30T06:07:08.000Z') });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({
    kind: 'dropped',
    reason: 'BEFORE_SYNC_START',
  });
  f.syncStartAt.mockResolvedValue(null);
  expect(
    await p.process(
      { ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-2`, deposit_paid_at: null },
      f.ctx,
    ),
  ).toMatchObject({ kind: 'dropped', reason: 'BEFORE_SYNC_START' });
  expect((await snapshot(db, f.ctx.app_id)).orders).toEqual([]);
});

it('[AC-B1-08h#32] 丢弃键按原因区分，补齐付款时间后仍可正常入库', async () => {
  const f = await fixture(db, { paid_at: null });
  const p = await pipeline(f.deps);
  f.findPid.mockResolvedValueOnce([]);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ reason: 'PID_NOT_OURS' });
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ reason: 'NO_PAY_TIME' });
  expect(await p.process({ ...f.incoming, paid_at: at(ATTR) }, f.ctx)).toMatchObject({
    kind: 'inserted',
  });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.dropKeys.map((r) => r.reason).sort()).toEqual(['NO_PAY_TIME', 'PID_NOT_OURS']);
  expect(s.drops.map((r) => r.count)).toEqual([1n, 1n]);
  expect(s.keys).toHaveLength(1);
  expect(s.orders).toHaveLength(1);
  expect(f.onImported).toHaveBeenCalledTimes(1);
});

it.each([
  ['outside-map', 'UNMAPPED_STATUS'],
  ['rights', 'ILLEGAL_TRANSITION'],
  ['punish', 'ILLEGAL_TRANSITION'],
] as const)(
  '[AC-B1-08h#33] 首态 $0 待处理，不建订单，重复仅刷新 detected_at',
  async (raw_status, reason) => {
    const f = await fixture(db, { raw_status });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'pending', reason });
    const first = await snapshot(db, f.ctx.app_id);
    expect(first.orders).toEqual([]);
    expect(first.keys).toEqual([]);
    expect(first.history).toEqual([]);
    expect(first.counters).toEqual([]);
    expect(first.pending).toEqual([
      expect.objectContaining({
        app_id: f.ctx.app_id,
        platform: 'pdd',
        sub_order_id: f.incoming.sub_order_id,
        order_id: null,
        reason,
        raw_status,
        raw_payload_id: 101n,
        status: 'open',
        detected_at: at(NOW),
      }),
    ]);
    f.clock.advanceMs(10_000);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'pending', reason });
    const second = await snapshot(db, f.ctx.app_id);
    expect(second).toEqual({
      ...first,
      pending: [{ ...first.pending[0], detected_at: f.clock.now() }],
    });
    expect(f.findUser).not.toHaveBeenCalled();
    expect(f.onImported).not.toHaveBeenCalled();
    expect(f.logger.warn.mock.calls.length + f.logger.error.mock.calls.length).toBeGreaterThan(0);
  },
);

it('[AC-B1-08h#34] 缺少适配后的子订单号使本页失败，不借用 order_id', async () => {
  const f = await fixture(db);
  const p = await pipeline(f.deps);
  const { sub_order_id, ...missing } = f.incoming;
  expect(sub_order_id).toBeTruthy();
  const before = await snapshot(db, f.ctx.app_id);
  await expect(p.process(missing, f.ctx)).rejects.toThrow();
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
});

it('[AC-B1-08h#35] 告警日志不含完整订单号、归属参数或买家标识', async () => {
  const f = await fixture(db, { paid_at: null });
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({
    kind: 'dropped',
    reason: 'NO_PAY_TIME',
  });
  const calls = [...f.logger.warn.mock.calls, ...f.logger.error.mock.calls];
  expect(calls.length).toBeGreaterThan(0);
  const text = JSON.stringify(calls);
  expect(text).not.toContain(f.incoming.sub_order_id);
  expect(text).not.toContain(f.incoming.order_id);
  expect(text).not.toContain('abcd1234');
  for (const call of calls) {
    const fields: unknown = call[0];
    expect(fields).toEqual(expect.any(Object));
    expect(
      Object.values(fields as Record<string, unknown>).every(
        (value) => value === null || typeof value !== 'object',
      ),
    ).toBe(true);
  }
});
