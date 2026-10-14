// B3-03e: completeness across passes and staying inside its bounds (design §5.3 完备性: the sort
// key and the cursor are one total order, the cursor time only comes from rows already eligible,
// so a row that becomes eligible later, or a new left-over run of a session handled earlier, lies
// after the cursor; §8 the sweeper only calls finalizer.finalize and writes no table itself).
import { createTestDatabase } from '@couli/db/testing';

import { expect, it } from 'vitest';

import { AdmissionUnavailableError } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { FinalizeOutcome } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  sweepStart,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import { RECOVERED, instance, runRow, sessionRow } from '../stream-finalize/kit.ts';
import {
  FakeLogger,
  LOCK_MS,
  RecordingFinalizer,
  agentSnapshot,
  at,
  leftover,
  seedLocks,
  sweeper,
  sweepOrder,
  usePgEach,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
const BASE = Date.parse('2026-10-06T10:00:00+08:00');

it('[AC-B3-03e#19] 完备性：游标停在 A 之后，此后才合格的行（锁期更晚）与 A 所在会话新出现的遗留 run 都在游标之后，下一轮全部扫到并收尾，finalize 用的是会话当前持锁的 run', async () => {
  const config = sweeperDefaults();
  const margin = config.marginMs;
  const a = await leftover(pg.db, BASE);
  const b = await leftover(pg.db, BASE + 1_000);
  const c = await leftover(pg.db, BASE + 30_000);
  const now1 = b.lockMs + margin;
  expect(c.lockMs).toBeGreaterThan(now1 - margin);

  const clock = at(now1);
  const finalizer = new RecordingFinalizer(instance(pg.db, { clock }).ports.finalizer);
  const first = await sweeper(pg.db, finalizer, clock, { ...config, maxPerTick: 1 }).sweepOnce(
    sweepStart(),
  );
  expect(finalizer.runIds).toEqual([a.runId]);
  expect(first).toMatchObject({
    processed: 1,
    finalized: 1,
    nextCursor: { lockExpiresAt: new Date(a.lockMs), sessionId: a.sessionId },
    wrapped: false,
  });
  expect((await sessionRow(pg.db, a.sessionId))['run_lock_run_id']).toBeNull();

  const a2 = await leftover(pg.db, now1, { sessionId: a.sessionId });
  const d = await leftover(pg.db, now1 + 500);
  expect(a2.lockMs).toBeGreaterThan(a.lockMs);

  clock.set(new Date(d.lockMs + margin));
  finalizer.calls.length = 0;
  const second = await sweeper(pg.db, finalizer, clock, config).sweepOnce(first.nextCursor);
  const expected = sweepOrder([b, c, a2, d]);
  expect(finalizer.runIds).toEqual(expected.map((l) => l.runId));
  expect(finalizer.runIds).not.toContain(a.runId);
  expect(second).toMatchObject({ processed: 4, finalized: 4, failed: 0, wrapped: true });
  for (const l of [a, b, c, a2, d]) {
    expect((await runRow(pg.db, l.runId))['final_event'], l.runId).not.toBeNull();
  }
  expect((await sessionRow(pg.db, a.sessionId))['run_lock_run_id']).toBeNull();
  expect(LOCK_MS).toBe(a.lockMs - a.acceptedAtMs);
});

it('[AC-B3-03e#20] 不越界：sweeper 自己不写 agent_sessions / agent_runs / agent_messages，只调用 finalizer.finalize(runId)（一个参数，值为会话的 run_lock_run_id）；替身返回 final / running / held 或抛错时表都逐行不变', async () => {
  const config = sweeperDefaults();
  const real = [await leftover(pg.db, BASE), await leftover(pg.db, BASE + 1_000, { cards: 1 })];
  const seeded = await seedLocks(pg.db, [{ lockMs: BASE + 2_000 + LOCK_MS }]);
  const rows = sweepOrder([...real, ...seeded]);
  const nowMs = Math.max(...rows.map((r) => r.lockMs)) + config.marginMs;
  const answers: (() => Promise<FinalizeOutcome>)[] = [
    () =>
      Promise.resolve({
        kind: 'final',
        frame: RECOVERED,
        refunded: true,
        snapshotQuotaLeft: null,
        quotaLeft: 0,
        wrote: true,
      }),
    () => Promise.resolve({ kind: 'running' }),
    () => Promise.resolve({ kind: 'held', reason: 'stored_frame_invalid' }),
    () => Promise.reject(new AdmissionUnavailableError('rolled_back')),
    () => Promise.reject(new Error('boom')),
  ];
  const before = await agentSnapshot(pg.db);
  for (const [i, answer] of answers.entries()) {
    const finalizer = new RecordingFinalizer(answer);
    const clock = at(nowMs);
    await sweeper(pg.db, finalizer, clock, config, new FakeLogger()).sweepOnce(sweepStart());
    expect(finalizer.runIds, String(i)).toEqual(rows.map((r) => r.runId));
    for (const call of finalizer.calls) expect(call.args, String(i)).toBe(1);
    for (const r of rows) {
      expect((await sessionRow(pg.db, r.sessionId))['run_lock_run_id'], String(i)).toBe(r.runId);
    }
    expect(await agentSnapshot(pg.db), String(i)).toBe(before);
  }
});
