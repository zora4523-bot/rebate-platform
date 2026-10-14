// B3-03h 第 9 节 5(c)(e)，Codex 第 1 轮 S1-1、S1-2：一轮在中途停止派发（设计 §5.3「锁连接报错即停止派发本轮
// 剩余条目」、T10 单轮时限 60 s；编排者口径：循环每次只交给一行的 sweeper，每次派发前查时限、锁连接、stop、
// 本轮上限）。真 PostgreSQL（每个用例一库）+ 真收尾（B3-03g finalizer）+ 真一行 sweeper（createSweeper，
// maxPerTick 1）+ 真循环；遗留 run 两条。只在 finalizer 外面包一层记录与挂起（挂起发生在碰数据库之前），
// 派发记录与轮次边界记在同一个事件表里，断言旧轮在超时 / 失锁之后一条都不再派发。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createSweeper,
  sweeperDefaults,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  agentSweepLoopDefaults,
  startAgentSweeper,
  type AgentSweepLoop,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import { instance, memberKey, runRow, usedOn } from '../stream-finalize/kit.ts';
import { leftover, type Leftover } from '../stream-sweeper/kit.ts';
import {
  HeldFinalizer,
  LEVEL,
  Logs,
  ManualSchedule,
  START_MS,
  advisoryHolders,
  settleWork,
  terminate,
  until,
  usePgEach,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

interface Worker {
  readonly logs: Logs;
  readonly schedule: ManualSchedule;
  readonly finalizer: HeldFinalizer;
  readonly loop: AgentSweepLoop;
}

async function twoLeftovers(): Promise<{
  runs: Leftover[];
  label: (id: string) => string;
  nowMs: number;
}> {
  const runs = [await leftover(pg.db, START_MS), await leftover(pg.db, START_MS + 1_000)];
  const names = new Map(runs.map((r, i) => [r.runId, `r${String(i + 1)}`]));
  const nowMs = Math.max(...runs.map((r) => r.lockMs)) + sweeperDefaults().marginMs + 1_000;
  return { runs, label: (id) => names.get(id) ?? id, nowMs };
}

/** A worker whose loop calls a real one-row sweeper over a recorded (optionally held) finalizer. */
function worker(
  db: Kysely<DB>,
  nowMs: number,
  events: string[],
  label: (id: string) => string,
  options: { prefix?: string; holdFirst?: boolean } = {},
): Worker {
  const clock = new FixedClock(new Date(nowMs));
  const logs = new Logs();
  const schedule = new ManualSchedule();
  const finalizer = new HeldFinalizer(
    instance(db, { clock }).ports.finalizer,
    events,
    label,
    options,
  );
  const step = createSweeper({
    db,
    finalizer,
    clock,
    config: { ...sweeperDefaults(), maxPerTick: 1 },
  });
  const loop = startAgentSweeper({
    step,
    db,
    clock,
    logger: logs.logger,
    config: agentSweepLoopDefaults(),
    schedule: schedule.schedule,
  });
  return { logs, schedule, finalizer, loop };
}

async function settledOnce(runs: readonly Leftover[]): Promise<void> {
  for (const run of runs) {
    expect(await runRow(pg.db, run.runId), run.runId).toMatchObject({
      end_reason: 'server_error',
      settle_result: 'refunded',
    });
    expect(await usedOn(pg.db, memberKey(run.subject), '2026-10-06'), run.runId).toBe(0);
  }
}

it('[AC-B3-03h#31] 单轮时限（S1-1）：第一条 finalize 挂起超过时限 → 本轮记 agent_sweep_tick_timeout 结束、锁释放、下一轮可以开始并处理两条；挂起的 finalize 稍后恢复时，旧轮不再派发第二条（r2 只在新一轮派发一次），新旧两轮的派发不重叠', async () => {
  const { runs, label, nowMs } = await twoLeftovers();
  const events: string[] = [];
  const w = worker(pg.db, nowMs, events, label, { holdFirst: true });
  try {
    const tick1 = w.schedule.fire('tick');
    await until('the first finalize is held', () => w.finalizer.calls.length === 1);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);
    await until(
      'the tick time limit is armed',
      () => w.schedule.pending('tick_timeout').length === 1,
    );
    expect(w.schedule.pending('tick_timeout')[0]!.delayMs).toBe(
      agentSweepLoopDefaults().tickTimeoutMs,
    );
    await w.schedule.fire('tick_timeout');
    await tick1;
    events.push('tick1-end');
    expect(w.logs.of('agent_sweep_tick_timeout')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        timeout_ms: agentSweepLoopDefaults().tickTimeoutMs,
      }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    events.push('tick2-start');
    await w.schedule.fire('tick');
    events.push('tick2-end');
    expect(w.logs.of('agent_sweep_skipped')).toEqual([]);
    expect(w.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 2, finalized: 2, failed: 0, wrapped: true }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    events.push('release');
    w.finalizer.release();
    const late = await w.finalizer.outcomes[0]!;
    expect(late).toMatchObject({ kind: 'final', wrote: false });
    await settleWork(pg.db);
    expect(events).toEqual([
      'call:r1',
      'tick1-end',
      'tick2-start',
      'call:r1',
      'call:r2',
      'tick2-end',
      'release',
    ]);
    expect(w.logs.of('agent_sweep_tick_timeout')).toHaveLength(1);
    expect(w.logs.of('agent_sweep_tick')).toHaveLength(1);
  } finally {
    w.finalizer.release();
    await w.loop.stop();
  }
  await settledOnce(runs);
  expect(await advisoryHolders(pg.db)).toEqual([]);
});

it('[AC-B3-03h#32] 失锁（S1-2）：A 持锁处理第一条时 finalize 挂起，外部 pg_terminate_backend 杀掉 A 的锁连接 → B 下一轮拿到锁并接管两条；放开 A 后 A 不再派发本轮剩余的 run（A 的派发只有挂起那一条），记 agent_sweep_lock_lost；A 的下一轮重新取锁照常', async () => {
  const { runs, label, nowMs } = await twoLeftovers();
  const events: string[] = [];
  const a = worker(pg.db, nowMs, events, label, { prefix: 'A:', holdFirst: true });
  const b = worker(pg.pool(), nowMs, events, label, { prefix: 'B:' });
  try {
    const tickA = a.schedule.fire('tick');
    await until('A holds the lock and its first finalize', () => a.finalizer.calls.length === 1);
    const holders = await advisoryHolders(pg.db);
    expect(holders).toHaveLength(1);
    await terminate(pg.db, holders[0]!);
    await until(
      'the killed backend released its lock',
      async () => (await advisoryHolders(pg.db)).length === 0,
    );
    events.push('A-killed');

    await b.schedule.fire('tick');
    events.push('B-tick-end');
    expect(b.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 2, finalized: 2, failed: 0, wrapped: true }),
    ]);

    events.push('A-release');
    a.finalizer.release();
    expect(await a.finalizer.outcomes[0]!).toMatchObject({ kind: 'final', wrote: false });
    await tickA;
    await settleWork(pg.db);
    expect(a.finalizer.calls).toEqual([runs[0]!.runId]);
    expect(events).toEqual([
      'A:call:r1',
      'A-killed',
      'B:call:r1',
      'B:call:r2',
      'B-tick-end',
      'A-release',
    ]);
    expect(a.logs.of('agent_sweep_lock_lost')).toEqual([
      expect.objectContaining({ level: LEVEL.error, error_name: expect.any(String) }),
    ]);
    expect(a.logs.of('agent_sweep_tick')).toEqual([]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    // A's next tick takes the lock again on a new connection; nothing is left.
    await a.schedule.fire('tick');
    expect(a.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 0, wrapped: true }),
    ]);
    expect(a.finalizer.calls).toHaveLength(1);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    a.finalizer.release();
    await a.loop.stop();
    await b.loop.stop();
  }
  await settledOnce(runs);
});
