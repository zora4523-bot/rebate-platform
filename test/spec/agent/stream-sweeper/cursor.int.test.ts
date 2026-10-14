// B3-03e: paging, cursor and fairness of one pass (design §5.3: ORDER BY and cursor are the same
// (run_lock_expires_at, session id) order; next pass continues after the cursor; a short page
// wraps to the start; at most maxPerTick rows per pass; failed rows still move the cursor; §7.2
// sweeper row: 499 of the first 500 failing → the 501st is handled in the next pass, 100 late
// sessions with small ids + 1 early session with a large id → the early one comes first).
// The finalizer here is a stand-in that writes nothing, so every row stays eligible and only the
// cursor decides what a pass sees.
import { createTestDatabase } from '@couli/db/testing';

import { expect, it } from 'vitest';

import { AdmissionUnavailableError } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  sweepStart,
  sweeperDefaults,
  type SweepCursor,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  FakeLogger,
  RecordingFinalizer,
  answerRunning,
  at,
  seedLocks,
  sweeper,
  sweepOrder,
  usePgEach,
  type SeedRow,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
const BASE = Date.parse('2026-10-06T10:00:00+08:00');

const cursorOf = (row: SeedRow): SweepCursor => ({
  lockExpiresAt: new Date(row.lockMs),
  sessionId: row.sessionId,
});
const ids = (rows: readonly SeedRow[]) => rows.map((r) => r.runId);

it('[AC-B3-03e#13] 分页与跨轮：按 (锁期, 会话 id) 升序；单轮满 maxPerTick 停在最后一条（wrapped=false），下一轮从游标之后继续，取不满一页回到起点（wrapped=true），再下一轮从头开始', async () => {
  const defaults = sweeperDefaults();
  const rows = sweepOrder(
    await seedLocks(pg.db, [
      { lockMs: BASE + 4_000 },
      { lockMs: BASE },
      { lockMs: BASE + 3_000 },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE + 2_000 },
    ]),
  );
  const finalizer = new RecordingFinalizer(answerRunning);
  const clock = at(BASE + 4_000 + defaults.marginMs);
  const s = sweeper(pg.db, finalizer, clock, { ...defaults, pageSize: 2, maxPerTick: 4 });

  const first = await s.sweepOnce(sweepStart());
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, 4)));
  expect(first).toEqual({
    processed: 4,
    finalized: 0,
    skipped: { running: 4, held: 0 },
    failed: 0,
    nextCursor: cursorOf(rows[3]!),
    wrapped: false,
  });

  finalizer.calls.length = 0;
  const second = await s.sweepOnce(first.nextCursor);
  expect(finalizer.runIds).toEqual(ids(rows.slice(4)));
  expect(second).toMatchObject({ processed: 1, nextCursor: sweepStart(), wrapped: true });

  finalizer.calls.length = 0;
  const third = await s.sweepOnce(second.nextCursor);
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, 4)));
  expect(third).toMatchObject({ processed: 4, nextCursor: cursorOf(rows[3]!), wrapped: false });
});

it('[AC-B3-03e#14] 单轮不超过 maxPerTick（页 3、单轮 5：两页共 5 条）；锁期相同的按会话 id 排序；剩余的下一轮处理', async () => {
  const defaults = sweeperDefaults();
  const rows = sweepOrder(
    await seedLocks(pg.db, [
      { lockMs: BASE + 2_000 },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE + 3_000 },
    ]),
  );
  const finalizer = new RecordingFinalizer(answerRunning);
  const clock = at(BASE + 3_000 + defaults.marginMs);
  const s = sweeper(pg.db, finalizer, clock, { ...defaults, pageSize: 3, maxPerTick: 5 });
  const first = await s.sweepOnce(sweepStart());
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, 5)));
  expect(first).toMatchObject({ processed: 5, nextCursor: cursorOf(rows[4]!), wrapped: false });
  finalizer.calls.length = 0;
  const second = await s.sweepOnce(first.nextCursor);
  expect(finalizer.runIds).toEqual(ids(rows.slice(5)));
  expect(second).toMatchObject({ processed: 2, nextCursor: sweepStart(), wrapped: true });
});

it('[AC-B3-03e#15] 排序键是锁期而非 id：100 个 id 小、到期晚的会话 + 1 个 id 大、到期早的会话，默认参数下第一条是到期早的那个，整轮按 (锁期, id) 顺序处理完 101 条', async () => {
  const small = Array.from({ length: 100 }, (_, i) => ({
    lockMs: BASE + 60_000 + (i % 7),
    sessionId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  }));
  const large = { lockMs: BASE, sessionId: 'ffffffff-ffff-4fff-bfff-ffffffffffff' };
  const rows = sweepOrder(await seedLocks(pg.db, [...small, large]));
  expect(rows[0]!.sessionId).toBe(large.sessionId);
  const defaults = sweeperDefaults();
  const finalizer = new RecordingFinalizer(answerRunning);
  const clock = at(BASE + 60_000 + 6 + defaults.marginMs);
  const result = await sweeper(pg.db, finalizer, clock, defaults).sweepOnce(sweepStart());
  expect(finalizer.runIds[0]).toBe(rows[0]!.runId);
  expect(finalizer.runIds).toEqual(ids(rows));
  expect(result).toMatchObject({ processed: 101, nextCursor: sweepStart(), wrapped: true });
});

it('[AC-B3-03e#16] finalize 抛可重试错误（AdmissionUnavailableError）或任意异常：记日志（含 run id）、计入 failed、游标照样推进并继续下一条；失败的条目绕回起点后重试', async () => {
  const defaults = sweeperDefaults();
  const rows = sweepOrder(
    await seedLocks(pg.db, [
      { lockMs: BASE },
      { lockMs: BASE + 1_000 },
      { lockMs: BASE + 2_000 },
      { lockMs: BASE + 3_000 },
    ]),
  );
  let failing = true;
  const finalizer = new RecordingFinalizer((runId) => {
    if (failing && runId === rows[1]!.runId) throw new AdmissionUnavailableError('rolled_back');
    if (failing && runId === rows[2]!.runId) return Promise.reject(new Error('boom'));
    return answerRunning();
  });
  const logger = new FakeLogger();
  const clock = at(BASE + 3_000 + defaults.marginMs);
  const s = sweeper(pg.db, finalizer, clock, { ...defaults, maxPerTick: 3 }, logger);

  const first = await s.sweepOnce(sweepStart());
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, 3)));
  expect(first).toEqual({
    processed: 3,
    finalized: 0,
    skipped: { running: 1, held: 0 },
    failed: 2,
    nextCursor: cursorOf(rows[2]!),
    wrapped: false,
  });
  expect(logger.mentions(rows[1]!.runId)).toBe(true);
  expect(logger.mentions(rows[2]!.runId)).toBe(true);

  finalizer.calls.length = 0;
  const second = await s.sweepOnce(first.nextCursor);
  expect(finalizer.runIds).toEqual([rows[3]!.runId]);
  expect(second).toMatchObject({ processed: 1, failed: 0, wrapped: true });

  failing = false;
  finalizer.calls.length = 0;
  const third = await s.sweepOnce(second.nextCursor);
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, 3)));
  expect(third).toMatchObject({ processed: 3, failed: 0, skipped: { running: 3, held: 0 } });
});

it('[AC-B3-03e#17] 默认参数下最早 500 条中 499 条可重试失败：本轮恰处理 500 条（failed 499）停在第 500 条，第 501 条在下一轮被处理', async () => {
  const defaults = sweeperDefaults();
  const seeded = Array.from({ length: defaults.maxPerTick + 1 }, (_, i) => ({
    lockMs: BASE + i * 10,
  }));
  const rows = sweepOrder(await seedLocks(pg.db, seeded));
  const failing = new Set(ids(rows.slice(0, defaults.maxPerTick - 1)));
  const finalizer = new RecordingFinalizer((runId) =>
    failing.has(runId)
      ? Promise.reject(new AdmissionUnavailableError('rolled_back'))
      : answerRunning(),
  );
  const clock = at(rows[rows.length - 1]!.lockMs + defaults.marginMs);
  const s = sweeper(pg.db, finalizer, clock, defaults, new FakeLogger());
  const first = await s.sweepOnce(sweepStart());
  expect(finalizer.runIds).toEqual(ids(rows.slice(0, defaults.maxPerTick)));
  expect(first).toEqual({
    processed: defaults.maxPerTick,
    finalized: 0,
    skipped: { running: 1, held: 0 },
    failed: defaults.maxPerTick - 1,
    nextCursor: cursorOf(rows[defaults.maxPerTick - 1]!),
    wrapped: false,
  });
  finalizer.calls.length = 0;
  const second = await s.sweepOnce(first.nextCursor);
  expect(finalizer.runIds).toEqual([rows[defaults.maxPerTick]!.runId]);
  expect(second).toMatchObject({ processed: 1, wrapped: true, nextCursor: sweepStart() });
});

it('[AC-B3-03e#18] 没有合格行：从起点或任意游标出发都是 processed 0、wrapped=true、游标回到起点，finalize 零调用', async () => {
  const defaults = sweeperDefaults();
  const rows = await seedLocks(pg.db, [{ lockMs: BASE }, { lockMs: BASE + 1_000 }]);
  const finalizer = new RecordingFinalizer(answerRunning);
  const early = at(BASE + defaults.marginMs - 1);
  const s = sweeper(pg.db, finalizer, early, defaults);
  const empty = {
    processed: 0,
    finalized: 0,
    skipped: { running: 0, held: 0 },
    failed: 0,
    nextCursor: sweepStart(),
    wrapped: true,
  };
  expect(await s.sweepOnce(sweepStart())).toEqual(empty);
  const last = sweepOrder(rows)[1]!;
  early.set(new Date(last.lockMs + defaults.marginMs));
  expect(await s.sweepOnce(cursorOf(last))).toEqual(empty);
  expect(finalizer.calls).toHaveLength(0);
});
