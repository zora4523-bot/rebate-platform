// B3-03e: which sessions a pass picks up (design §5.3 source query; §5.1 running = lock holder and
// now < run_lock_expires_at, time only from the injected Clock; §3.5 held runs are skipped;
// BR-AI-23 细则「谁来收尾」: without a new request the worker finalizes left-over runs).
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  sweepStart,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import { START_MS, instance, runRow, sessionRow } from '../stream-finalize/kit.ts';
import {
  LOCK_MS,
  RecordingFinalizer,
  at,
  leftover,
  markHold,
  newSessionWithId,
  sweeper,
  usePgEach,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-03e#3] 发现条件：只收尾「有锁、锁期 ≤ now − 余量、run 无 hold」的会话（与 end_reason 是否已写无关：S4 已提交、未结算即崩溃的也收尾）；锁未到期、在余量内、已 hold、无锁（含已收尾）的一律不碰，finalize 零调用', async () => {
  const config = sweeperDefaults();
  const margin = config.marginMs;
  expect(margin).toBeGreaterThan(0);
  const now = START_MS + LOCK_MS + margin + 5_000;
  const clock = at(now);

  const due = await leftover(pg.db, START_MS);
  // Ending committed by the live process (S4), then a crash before settling: still a left-over.
  const decided = await leftover(pg.db, START_MS + 3_000, { ending: 'timeout' });
  expect(await runRow(pg.db, decided.runId)).toMatchObject({
    end_reason: 'timeout',
    final_event: null,
  });
  const notExpired = await leftover(pg.db, now - 10_000);
  const inMargin = await leftover(pg.db, now - margin + 1 - LOCK_MS);
  expect(inMargin.lockMs).toBe(now - margin + 1);
  expect(inMargin.lockMs).toBeLessThanOrEqual(now);
  const held = await leftover(pg.db, START_MS + 1_000);
  await markHold(pg.db, held.runId, START_MS + 2_000);
  const finished = await leftover(pg.db, START_MS + 2_000);
  const other = instance(pg.db, { clock: at(now) });
  expect(await other.ports.finalizer.finalize(finished.runId)).toMatchObject({ kind: 'final' });
  const noRun = await newSessionWithId(pg.db, randomUUID(), START_MS);

  const untouched = [notExpired, inMargin, held, finished];
  const before = await Promise.all(
    untouched.map(async (l) => [
      await runRow(pg.db, l.runId),
      await sessionRow(pg.db, l.sessionId),
    ]),
  );
  const noRunBefore = await sessionRow(pg.db, noRun);

  const real = instance(pg.db, { clock });
  const finalizer = new RecordingFinalizer(real.ports.finalizer);
  const result = await sweeper(pg.db, finalizer, clock, config).sweepOnce(sweepStart());

  expect(due.lockMs).toBeLessThan(decided.lockMs);
  expect(finalizer.runIds).toEqual([due.runId, decided.runId]);
  expect(result).toEqual({
    processed: 2,
    finalized: 2,
    skipped: { running: 0, held: 0 },
    failed: 0,
    nextCursor: sweepStart(),
    wrapped: true,
  });
  expect((await runRow(pg.db, due.runId))['final_event']).not.toBeNull();
  expect(await runRow(pg.db, decided.runId)).toMatchObject({
    end_reason: 'timeout',
    final_event: { type: 'done', data: { finish_reason: 'timeout' } },
  });
  expect((await sessionRow(pg.db, decided.sessionId))['run_lock_run_id']).toBeNull();
  const after = await Promise.all(
    untouched.map(async (l) => [
      await runRow(pg.db, l.runId),
      await sessionRow(pg.db, l.sessionId),
    ]),
  );
  expect(after).toEqual(before);
  expect(await sessionRow(pg.db, noRun)).toEqual(noRunBefore);
});

it('[AC-B3-03e#4] 时钟：只用注入的 clock；锁期恰为 now − 余量的合格（<=），晚 1 ms 的不合格；余量 0 与默认余量、2026 与 2099 两个时代都成立', async () => {
  const defaults = sweeperDefaults();
  // Descending eras: a later era's left-over (lock in the future of an earlier era) never becomes
  // eligible for an earlier pass.
  const cases = [
    { base: Date.parse('2099-06-01T12:00:00+08:00'), marginMs: defaults.marginMs },
    { base: Date.parse('2098-06-01T12:00:00+08:00'), marginMs: 0 },
    { base: START_MS, marginMs: defaults.marginMs },
    { base: START_MS - 86_400_000, marginMs: 0 },
  ];
  for (const { base, marginMs } of cases) {
    const label = `${new Date(base).toISOString()} margin ${String(marginMs)}`;
    const onEdge = await leftover(pg.db, base);
    const late = await leftover(pg.db, base + 1);
    expect(late.lockMs, label).toBe(onEdge.lockMs + 1);
    const clock = at(onEdge.lockMs + marginMs);
    const real = instance(pg.db, { clock });
    const finalizer = new RecordingFinalizer(real.ports.finalizer);
    const result = await sweeper(pg.db, finalizer, clock, {
      ...defaults,
      marginMs,
    }).sweepOnce(sweepStart());
    expect(finalizer.runIds, label).toEqual([onEdge.runId]);
    expect(result, label).toMatchObject({ processed: 1, finalized: 1, failed: 0, wrapped: true });
    expect((await runRow(pg.db, onEdge.runId))['final_event'], label).not.toBeNull();
    expect((await runRow(pg.db, late.runId))['final_event'], label).toBeNull();
    expect((await sessionRow(pg.db, late.sessionId))['run_lock_run_id'], label).toBe(late.runId);
  }
});
