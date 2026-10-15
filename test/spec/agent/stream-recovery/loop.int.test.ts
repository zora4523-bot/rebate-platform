// B3-03h 第 9 节 5：worker 循环本身（设计 couli-runs/B3-03g/design.md v5 §5.3「worker 内循环 + advisory
// lock」、§10.1 T10；编排者第 2 轮口径：循环交给一行的 sweeper 逐行调用，每次派发前查 stop、本轮上限、时限、
// 锁连接）。真 PostgreSQL（本文件一库；advisory lock 按库），一行 sweeper 用脚本替身（每次 sweepOnce 至多
// 处理一行，内容 B3-03e 已测），tick 只由注入的 schedule 触发，时长只走注入的 Clock：两轮周期、游标跨轮、
// 本轮上限、step 抛错后下一轮照常、按 Clock 的时限、running 期间不并发、按定时器的时限（旧轮不再派发）、stop
// 等进行中的一行且不再派发、stop 的等待上限。真 finalize 下的超时与失锁见 takeover.int.test.ts。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  sweepStart,
  type SweepCursor,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import {
  agentSweepLoopDefaults,
  startAgentSweeper,
  type AgentSweepLoop,
  type AgentSweepLoopConfig,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import { usePg } from '../stream-finalize/kit.ts';
import {
  LEVEL,
  Logs,
  ManualSchedule,
  START_MS,
  ScriptedSweeper,
  advisoryHolders,
  connectionFailsOnce,
  result,
  settleWork,
  statementFailsOnce,
  terminate,
  until,
} from './kit.ts';

const pg = usePg(createTestDatabase);

interface Rig {
  readonly clock: FixedClock;
  readonly logs: Logs;
  readonly schedule: ManualSchedule;
  readonly step: ScriptedSweeper;
  readonly config: AgentSweepLoopConfig;
  readonly loop: AgentSweepLoop;
}

function rig(
  options: { random?: () => number; config?: Partial<AgentSweepLoopConfig>; db?: Kysely<DB> } = {},
): Rig {
  const clock = new FixedClock(new Date(START_MS));
  const logs = new Logs();
  const schedule = new ManualSchedule();
  const step = new ScriptedSweeper();
  const config = { ...agentSweepLoopDefaults(), ...options.config };
  const loop = startAgentSweeper({
    step,
    db: options.db ?? pg.db,
    clock,
    logger: logs.logger,
    config,
    schedule: schedule.schedule,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  return { clock, logs, schedule, step, config, loop };
}

function cursor(n: number): SweepCursor {
  return {
    lockExpiresAt: new Date(START_MS - 60_000 + n * 1_000),
    sessionId: `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
  };
}

/** One row handled (a step result of a one-row sweeper). */
const one = (n: number, kind: 'final' | 'running' = 'final') =>
  result({
    processed: 1,
    finalized: kind === 'final' ? 1 : 0,
    skipped: { running: kind === 'running' ? 1 : 0, held: 0 },
    nextCursor: cursor(n),
    wrapped: false,
  });
/** Nothing left from this cursor: back to the start. */
const done = () => result({ processed: 0, nextCursor: sweepStart(), wrapped: true });

it('[AC-B3-03h#8] 连续两轮周期：每次延迟为 interval ×(1 ± 抖动)，tick 先排下一轮再干活；一轮逐行调用 step，到本轮上限即停、记一条 agent_sweep_tick（行数合计与 Clock 计的耗时）；下一轮从上一轮停下的游标接着走，wrapped 时本轮结束；每轮结束锁已释放', async () => {
  const draws = [0, 0.75, 0.999_999];
  const r = rig({ random: () => draws.shift() ?? 0.5, config: { maxPerTick: 2 } });
  try {
    const { intervalMs, jitterRatio } = r.config;
    const delay = (x: number) => Math.round(intervalMs * (1 + jitterRatio * (2 * x - 1)));
    expect(r.schedule.armed.map((a) => [a.timer, a.delayMs])).toEqual([['tick', delay(0)]]);
    const answers = [one(1), one(2, 'running'), one(3), done()];
    r.step.answer = () => {
      r.clock.advanceMs(400);
      return Promise.resolve(answers.shift()!);
    };

    await r.schedule.fire('tick');
    expect(r.schedule.pending('tick').map((a) => a.delayMs)).toEqual([delay(0.75)]);
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1)]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    // A tick that ended normally leaves no time-limit timer behind.
    expect(r.schedule.armed.filter((a) => a.timer === 'tick_timeout')).toHaveLength(1);
    expect(r.schedule.pending('tick_timeout')).toEqual([]);

    await r.schedule.fire('tick');
    expect(r.schedule.pending('tick').map((a) => a.delayMs)).toEqual([delay(0.999_999)]);
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1), cursor(2), cursor(3)]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    expect(r.schedule.armed.filter((a) => a.timer === 'tick_timeout')).toHaveLength(2);
    expect(r.schedule.pending('tick_timeout')).toEqual([]);

    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({
        level: LEVEL.info,
        processed: 2,
        finalized: 1,
        skipped_running: 1,
        skipped_held: 0,
        failed: 0,
        wrapped: false,
        duration_ms: 800,
      }),
      expect.objectContaining({ processed: 1, finalized: 1, wrapped: true, duration_ms: 800 }),
    ]);
    for (const a of r.schedule.armed.filter((x) => x.timer === 'tick')) {
      expect(a.delayMs).toBeGreaterThanOrEqual(intervalMs * (1 - jitterRatio));
      expect(a.delayMs).toBeLessThanOrEqual(intervalMs * (1 + jitterRatio));
    }
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#9] step 抛错：本轮不再派发、记 error agent_sweep_failed（只记错误名，不记消息）、锁照样释放、游标停在最后一次成功处；下一轮从那里照常', async () => {
  const r = rig();
  try {
    const answers: (() => Promise<ReturnType<typeof done>>)[] = [
      () => Promise.resolve(one(1)),
      () => Promise.reject(new TypeError('用户原话 13800138000 不得入日志')),
      () => Promise.resolve(done()),
    ];
    r.step.answer = () => answers.shift()!();
    await r.schedule.fire('tick');
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1)]);
    expect(r.logs.of('agent_sweep_failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, error_name: 'TypeError' }),
    ]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([]);
    expect(r.logs.lines.join('\n')).not.toContain('13800138000');
    expect(await advisoryHolders(pg.db)).toEqual([]);

    await r.schedule.fire('tick');
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1), cursor(1)]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 0, wrapped: true }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#10] 按 Clock 的单轮时限：一行处理完时 Clock 已过 tickTimeoutMs → 不再派发下一行，记 warn agent_sweep_tick_timeout、锁释放；已完成那一行的游标保留，下一轮从它之后接着走', async () => {
  const r = rig();
  try {
    let calls = 0;
    r.step.answer = () => {
      calls += 1;
      if (calls === 1) r.clock.advanceMs(r.config.tickTimeoutMs);
      return Promise.resolve(calls === 1 ? one(1) : done());
    };
    await r.schedule.fire('tick');
    expect(r.step.cursors).toEqual([sweepStart()]);
    expect(r.logs.of('agent_sweep_tick_timeout')).toEqual([
      expect.objectContaining({
        level: LEVEL.warn,
        timeout_ms: r.config.tickTimeoutMs,
        processed: 1,
      }),
    ]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    await r.schedule.fire('tick');
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1)]);
    expect(r.logs.of('agent_sweep_tick')).toHaveLength(1);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#11] running 期间再次触发不并发：第二次 tick 记 agent_sweep_skipped busy 后立即结束，不借连接、不调 step；前一轮照常结束并释放锁', async () => {
  const r = rig();
  try {
    const first = r.schedule.fire('tick');
    await r.step.started(1);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);
    await r.schedule.fire('tick');
    expect(r.step.cursors).toHaveLength(1);
    expect(r.logs.of('agent_sweep_skipped')).toEqual([expect.objectContaining({ reason: 'busy' })]);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);

    r.step.answer = () => Promise.resolve(done());
    r.step.pending[0]!.resolve(one(1));
    await first;
    expect(r.step.cursors).toEqual([sweepStart(), cursor(1)]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 1, finalized: 1, wrapped: true }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    expect(r.schedule.pending('tick')).toHaveLength(1);
  } finally {
    for (const p of r.step.pending) p.resolve(done());
    await r.loop.stop();
  }
});

it('[AC-B3-03h#12] 按定时器的单轮时限：一行挂起时 tick_timeout 触发 → 本轮立即结束（warn agent_sweep_tick_timeout）、锁释放；挂起的那一行稍后成功或失败都被忽略，旧轮此后一行都不再派发；下一轮从旧游标照常', async () => {
  const r = rig();
  try {
    const tick = r.schedule.fire('tick');
    await r.step.started(1);
    await until(
      'the tick time limit is armed',
      () => r.schedule.pending('tick_timeout').length === 1,
    );
    expect(r.schedule.pending('tick_timeout')[0]!.delayMs).toBe(r.config.tickTimeoutMs);
    await r.schedule.fire('tick_timeout');
    await tick;
    expect(r.logs.of('agent_sweep_tick_timeout')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, timeout_ms: r.config.tickTimeoutMs }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    // The abandoned step resolves late with more rows to go: the old tick dispatches nothing.
    r.step.pending[0]!.resolve(one(1));
    await settleWork(pg.db);
    expect(r.step.cursors).toEqual([sweepStart()]);

    r.step.answer = () => Promise.resolve(done());
    await r.schedule.fire('tick');
    expect(r.step.cursors).toEqual([sweepStart(), sweepStart()]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 0, wrapped: true }),
    ]);
    expect(r.logs.of('agent_sweep_failed')).toEqual([]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#13] 迟到的拒绝：被定时器放弃的那一行稍后拒绝，不成为未处理的拒绝、不记 agent_sweep_failed、不派发', async () => {
  const r = rig();
  try {
    const tick = r.schedule.fire('tick');
    await r.step.started(1);
    await until(
      'the tick time limit is armed',
      () => r.schedule.pending('tick_timeout').length === 1,
    );
    await r.schedule.fire('tick_timeout');
    await tick;
    r.step.pending[0]!.reject(new Error('late'));
    await settleWork(pg.db);
    expect(r.step.cursors).toHaveLength(1);
    expect(r.logs.of('agent_sweep_failed')).toEqual([]);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#14] stop：进行中的一行做完后不再派发下一行，解锁后 stop 才 resolve；取消已排的 tick，停后迟到的 tick 什么都不做；重复调用都 resolve', async () => {
  const r = rig();
  const tick = r.schedule.fire('tick');
  await r.step.started(1);
  const armedTick = r.schedule.pending('tick')[0]!;
  let stopped = false;
  const stopping = r.loop.stop().then(() => (stopped = true));
  await until('stop arms its upper bound', () => r.schedule.pending('stop_timeout').length === 1);
  expect(r.schedule.pending('stop_timeout')[0]!.delayMs).toBe(r.config.stopTimeoutMs);
  expect(stopped).toBe(false);
  expect(armedTick.cancelled).toBe(true);

  r.step.pending[0]!.resolve(one(1));
  await tick;
  await stopping;
  expect(r.step.cursors).toEqual([sweepStart()]);
  expect(r.logs.of('agent_sweep_tick')).toEqual([
    expect.objectContaining({ processed: 1, wrapped: false }),
  ]);
  expect(await advisoryHolders(pg.db)).toEqual([]);

  await r.schedule.fireLate(armedTick);
  expect(r.step.cursors).toHaveLength(1);
  await expect(r.loop.stop()).resolves.toBeUndefined();
  expect(r.schedule.pending('tick')).toEqual([]);
});

it('[AC-B3-03h#33] stop 的等待有上限：进行中的一行挂起时 stop_timeout 触发即 resolve；之后不再起新一轮，挂起的一行结束后也不再派发', async () => {
  const r = rig();
  const tick = r.schedule.fire('tick');
  await r.step.started(1);
  const stopping = r.loop.stop();
  await until('stop arms its upper bound', () => r.schedule.pending('stop_timeout').length === 1);
  await r.schedule.fire('stop_timeout');
  await stopping;
  expect(r.schedule.pending('tick')).toEqual([]);

  r.step.pending[0]!.resolve(one(1));
  await tick;
  await settleWork(pg.db);
  expect(await advisoryHolders(pg.db)).toEqual([]);
  expect(r.step.cursors).toHaveLength(1);
  expect(r.schedule.pending('tick')).toEqual([]);
});

/** The second tick of a loop whose first tick failed: runs as usual (not 'busy'), lock released. */
async function nextTickRunsAsUsual(r: Rig): Promise<void> {
  r.step.answer = () => Promise.resolve(done());
  const calls = r.step.cursors.length;
  await r.schedule.fire('tick');
  expect(r.logs.of('agent_sweep_skipped')).toEqual([]);
  expect(r.step.cursors).toHaveLength(calls + 1);
  expect(r.logs.of('agent_sweep_tick').at(-1)).toMatchObject({ processed: 0, wrapped: true });
  expect(await advisoryHolders(pg.db)).toEqual([]);
}

it('[AC-B3-03h#37] 借连接失败（db.connection().execute 在回调前就拒绝）：这一轮的 promise 正常结束（不拒绝、无未处理的拒绝），恰一条 error agent_sweep_lock_failed {stage: acquire}，step 未被调用；running 已复位，下一轮照常取锁、记 agent_sweep_tick、锁已释放', async () => {
  const flaky = connectionFailsOnce(pg.db);
  const r = rig({ db: flaky.db });
  try {
    r.step.answer = () => Promise.resolve(done());
    await expect(r.schedule.fire('tick')).resolves.toBeUndefined();
    expect(flaky.failed()).toBe(1);
    expect(r.step.cursors).toEqual([]);
    expect(r.logs.of('agent_sweep_lock_failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, stage: 'acquire', error_name: 'Error' }),
    ]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([]);
    expect(r.logs.lines.join('\n')).not.toContain('fixture: no connection available');
    await nextTickRunsAsUsual(r);
    expect(r.logs.of('agent_sweep_lock_failed')).toHaveLength(1);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#38] 取锁语句抛错（pg_try_advisory_lock 失败、连接本身完好）：这一轮正常结束不拒绝，恰一条 agent_sweep_lock_failed {stage: acquire}，step 未被调用，锁未被持有；下一轮照常', async () => {
  const flaky = statementFailsOnce(pg.db, /pg_try_advisory_lock/);
  const r = rig({ db: flaky.db });
  try {
    await expect(r.schedule.fire('tick')).resolves.toBeUndefined();
    expect(flaky.failed()).toBe(1);
    expect(r.step.cursors).toEqual([]);
    expect(r.logs.of('agent_sweep_lock_failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, stage: 'acquire' }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    await nextTickRunsAsUsual(r);
    expect(r.logs.of('agent_sweep_lock_failed')).toHaveLength(1);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#39] 解锁失败（最后一行之后锁连接的后端被杀，unlock 报错）：这一轮正常结束不拒绝，记本轮的 agent_sweep_tick 外加恰一条 agent_sweep_lock_failed {stage: unlock}；running 已复位，下一轮照常取锁、记 agent_sweep_tick、锁已释放', async () => {
  const r = rig();
  try {
    r.step.answer = async () => {
      // The only row is done; the lock connection dies before the tick unlocks.
      const holders = await advisoryHolders(pg.db);
      expect(holders).toHaveLength(1);
      await terminate(pg.db, holders[0]!);
      await until(
        'the killed backend released its lock',
        async () => (await advisoryHolders(pg.db)).length === 0,
      );
      r.step.answer = null;
      return done();
    };
    await expect(r.schedule.fire('tick')).resolves.toBeUndefined();
    expect(r.step.cursors).toHaveLength(1);
    expect(r.logs.of('agent_sweep_lock_failed')).toEqual([
      expect.objectContaining({
        level: LEVEL.error,
        stage: 'unlock',
        error_name: expect.any(String),
      }),
    ]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 0, wrapped: true }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    await nextTickRunsAsUsual(r);
    expect(r.logs.of('agent_sweep_lock_failed')).toHaveLength(1);
  } finally {
    await r.loop.stop();
  }
});
