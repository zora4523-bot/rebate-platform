// B3-03e: repeated and concurrent passes settle each run once (design §4.2 I1 只结算一次, §4.3 two
// finalizeRun serialize on the session and run row locks, §5.3 running / held are skipped;
// BR-AI-15 退还只发生一次; BR-AI-23 细则「谁来收尾」).
import { createTestDatabase } from '@couli/db/testing';

import { expect, it } from 'vitest';

import { AdmissionUnavailableError } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { FinalizeOutcome } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  sweepStart,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  RECOVERED,
  instance,
  memberKey,
  runRow,
  sessionRow,
  settled,
  stored,
  usedOn,
} from '../stream-finalize/kit.ts';
import {
  RecordingFinalizer,
  agentSnapshot,
  at,
  leftover,
  seedLocks,
  someoneBlockedBy,
  sweeper,
  sweepOrder,
  usePgEach,
  type Call,
  type Leftover,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
const BASE = Date.parse('2026-10-06T10:00:00+08:00');
const DAY = '2026-10-06';

async function leftovers(n: number): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (let i = 0; i < n; i += 1) out.push(await leftover(pg.db, BASE + i * 1_000));
  return out;
}

/** Per run: exactly one recorded call wrote the terminal; every other call saw it already there. */
function writtenOnce(runs: readonly Leftover[], calls: readonly Call[]): void {
  for (const run of runs) {
    const mine = calls.filter((c) => c.runId === run.runId);
    expect(mine.length, run.runId).toBeGreaterThanOrEqual(1);
    for (const c of mine) expect(c.outcome?.kind, run.runId).toBe('final');
    expect(
      mine.filter((c) => c.outcome?.kind === 'final' && c.outcome.wrote).length,
      run.runId,
    ).toBe(1);
  }
}

async function settledOnce(runs: readonly Leftover[]): Promise<void> {
  for (const run of runs) {
    const row = await runRow(pg.db, run.runId);
    expect(row, run.runId).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
    expect(row['final_event'], run.runId).toEqual(stored(RECOVERED));
    expect((await sessionRow(pg.db, run.sessionId))['run_lock_run_id'], run.runId).toBeNull();
    expect(await usedOn(pg.db, memberKey(run.subject), DAY), run.runId).toBe(0);
  }
}

it('[AC-B3-03e#8] 连续多轮：同一遗留 run 第一轮收尾后，第二轮（从返回的游标或从起点、时钟再推进）不再调用 finalize，表与额度计数不变', async () => {
  const [left] = await leftovers(1);
  const config = sweeperDefaults();
  const clock = at(left!.lockMs + config.marginMs);
  const finalizer = new RecordingFinalizer(instance(pg.db, { clock }).ports.finalizer);
  const s = sweeper(pg.db, finalizer, clock, config);
  const first = await s.sweepOnce(sweepStart());
  expect(first).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
  const after = await agentSnapshot(pg.db);
  const used = await usedOn(pg.db, memberKey(left!.subject), DAY);
  expect(used).toBe(0);

  const second = await s.sweepOnce(first.nextCursor);
  clock.advanceMs(3_600_000);
  const third = await s.sweepOnce(sweepStart());
  for (const r of [second, third]) {
    expect(r).toEqual({
      processed: 0,
      finalized: 0,
      skipped: { running: 0, held: 0 },
      failed: 0,
      nextCursor: sweepStart(),
      wrapped: true,
    });
  }
  expect(finalizer.runIds).toEqual([left!.runId]);
  expect(await agentSnapshot(pg.db)).toBe(after);
  expect(await usedOn(pg.db, memberKey(left!.subject), DAY)).toBe(used);
});

it('[AC-B3-03e#9] 收尾已提交但回包丢失（finalize 抛错）：本轮计 failed，下一轮该会话已不合格、不再调用，结算只有一次', async () => {
  const [left] = await leftovers(1);
  const config = sweeperDefaults();
  const clock = at(left!.lockMs + config.marginMs);
  const real = instance(pg.db, { clock }).ports.finalizer;
  let lose = true;
  const finalizer = new RecordingFinalizer(async (runId) => {
    const out = await real.finalize(runId);
    if (lose) {
      lose = false;
      throw new AdmissionUnavailableError('unknown');
    }
    return out;
  });
  const s = sweeper(pg.db, finalizer, clock, config);
  const first = await s.sweepOnce(sweepStart());
  expect(first).toMatchObject({ processed: 1, finalized: 0, failed: 1 });
  const after = await agentSnapshot(pg.db);
  clock.advanceMs(60_000);
  const second = await s.sweepOnce(first.nextCursor);
  const third = await s.sweepOnce(sweepStart());
  expect(second).toMatchObject({ processed: 0, wrapped: true });
  expect(third).toMatchObject({ processed: 0, wrapped: true });
  expect(finalizer.runIds).toEqual([left!.runId]);
  expect(await agentSnapshot(pg.db)).toBe(after);
  await settledOnce([left!]);
});

it('[AC-B3-03e#10] 两个 sweeper 实例并发：A 持第一条的收尾事务未提交时 B 排在其后，放行后 B 读到同一终态；每条只写一次终态、只退一次，两边都不计 failed', async () => {
  const runs = await leftovers(3);
  const config = sweeperDefaults();
  const nowMs = Math.max(...runs.map((r) => r.lockMs)) + config.marginMs;
  const ca = at(nowMs);
  const cb = at(nowMs);
  const ia = instance(pg.db, { clock: ca });
  const ib = instance(pg.db, { clock: cb });
  const fa = new RecordingFinalizer(ia.ports.finalizer);
  const fb = new RecordingFinalizer(ib.ports.finalizer);
  const sa = sweeper(pg.db, fa, ca, config);
  const sb = sweeper(pg.db, fb, cb, config);
  const first = sweepOrder(runs)[0]!;

  const held = ia.hooks.hold('finalize');
  const passA = settled(sa.sweepOnce(sweepStart()));
  let passB: Promise<unknown> = Promise.resolve();
  try {
    const pidA = await held.reached;
    passB = settled(sb.sweepOnce(sweepStart()));
    await someoneBlockedBy(pg.db, pidA);
    expect((await runRow(pg.db, first.runId))['final_event']).toBeNull();
  } finally {
    held.release();
  }
  const [ra, rb] = await Promise.all([passA, passB]);
  for (const r of [ra, rb]) {
    expect(r).not.toBeInstanceOf(Error);
    expect(r).toMatchObject({ failed: 0, skipped: { running: 0, held: 0 } });
  }
  expect(fa.calls[0]).toMatchObject({
    runId: first.runId,
    outcome: { kind: 'final', wrote: true },
  });
  expect(fb.calls[0]).toMatchObject({
    runId: first.runId,
    outcome: { kind: 'final', wrote: false },
  });
  writtenOnce(runs, [...fa.calls, ...fb.calls]);
  await settledOnce(runs);
});

it('[AC-B3-03e#11] 两个 sweeper 实例同时从起点开跑（无人为编排）：每条只写一次终态、只退一次，两边 failed 均为 0', async () => {
  const runs = await leftovers(6);
  const config = { ...sweeperDefaults(), pageSize: 2 };
  const nowMs = Math.max(...runs.map((r) => r.lockMs)) + config.marginMs;
  const fa = new RecordingFinalizer(instance(pg.db, { clock: at(nowMs) }).ports.finalizer);
  const fb = new RecordingFinalizer(instance(pg.db, { clock: at(nowMs) }).ports.finalizer);
  const [ra, rb] = await Promise.all([
    sweeper(pg.db, fa, at(nowMs), config).sweepOnce(sweepStart()),
    sweeper(pg.db, fb, at(nowMs), config).sweepOnce(sweepStart()),
  ]);
  for (const r of [ra, rb]) expect(r).toMatchObject({ failed: 0, wrapped: true });
  writtenOnce(runs, [...fa.calls, ...fb.calls]);
  await settledOnce(runs);
});

it('[AC-B3-03e#12] finalize 返回 running / held 时跳过：分别计入 skipped.running / skipped.held，不计 failed、不计 finalized，游标照常推进', async () => {
  const config = sweeperDefaults();
  const rows = sweepOrder(
    await seedLocks(pg.db, [{ lockMs: BASE }, { lockMs: BASE + 1 }, { lockMs: BASE + 2 }]),
  );
  const answers: FinalizeOutcome[] = [
    { kind: 'running' },
    { kind: 'held', reason: 'facts_inconsistent' },
    {
      kind: 'final',
      frame: RECOVERED,
      refunded: true,
      snapshotQuotaLeft: null,
      quotaLeft: 0,
      wrote: true,
    },
  ];
  const byRun = new Map(rows.map((r, i) => [r.runId, answers[i]!]));
  const finalizer = new RecordingFinalizer((runId) => Promise.resolve(byRun.get(runId)!));
  const clock = at(BASE + 2 + config.marginMs);
  const result = await sweeper(pg.db, finalizer, clock, {
    ...config,
    maxPerTick: 3,
  }).sweepOnce(sweepStart());
  expect(finalizer.runIds).toEqual(rows.map((r) => r.runId));
  expect(result).toEqual({
    processed: 3,
    finalized: 1,
    skipped: { running: 1, held: 1 },
    failed: 0,
    nextCursor: { lockExpiresAt: new Date(rows[2]!.lockMs), sessionId: rows[2]!.sessionId },
    wrapped: false,
  });
});
