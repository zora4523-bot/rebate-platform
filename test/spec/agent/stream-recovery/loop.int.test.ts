// B3-03h 第 9 节 5：worker 循环本身（设计 couli-runs/B3-03g/design.md v5 §5.3「worker 内循环 + advisory
// lock」、§10.1 T10）。真 PostgreSQL（本文件一库；advisory lock 按库，不与别的测试文件互相看见），sweeper 用
// 脚本替身（sweepOnce 的内容 B3-03e 已测），tick 只由注入的 schedule 触发，时长只走注入的 Clock：
// 两轮周期确实执行、游标跨轮保存、异常后继续、持锁连接被杀后锁自动释放并由另一 worker 接管、running 期间
// 不并发、单轮时限、stop 等进行中的一轮。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { sweepStart } from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
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
  result,
  terminate,
  until,
} from './kit.ts';

const pg = usePg(createTestDatabase);

interface Rig {
  readonly clock: FixedClock;
  readonly logs: Logs;
  readonly schedule: ManualSchedule;
  readonly sweeper: ScriptedSweeper;
  readonly config: AgentSweepLoopConfig;
  readonly loop: AgentSweepLoop;
}

function rig(options: { random?: () => number; config?: Partial<AgentSweepLoopConfig> } = {}): Rig {
  const clock = new FixedClock(new Date(START_MS));
  const logs = new Logs();
  const schedule = new ManualSchedule();
  const sweeper = new ScriptedSweeper();
  const config = { ...agentSweepLoopDefaults(), ...options.config };
  const loop = startAgentSweeper({
    sweeper,
    db: pg.db,
    clock,
    logger: logs.logger,
    config,
    schedule: schedule.schedule,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  return { clock, logs, schedule, sweeper, config, loop };
}

const cursorA = {
  lockExpiresAt: new Date(START_MS - 5_000),
  sessionId: '0190a000-0000-7000-8000-00000000000a',
};
const cursorB = {
  lockExpiresAt: new Date(START_MS - 1_000),
  sessionId: '0190a000-0000-7000-8000-00000000000b',
};

it('[AC-B3-03h#8] 连续两轮周期确实执行：每次延迟为 interval ×(1 ± 抖动)（注入的 random 决定），tick 先排下一轮再干活；每轮在一条连接上取锁、调 sweepOnce、释放锁，记一条 agent_sweep_tick（计数与 Clock 计的耗时）；游标跨轮保存', async () => {
  const draws = [0, 0.75, 0.999_999];
  const r = rig({ random: () => draws.shift() ?? 0.5 });
  try {
    const { intervalMs, jitterRatio } = r.config;
    const delay = (x: number) => Math.round(intervalMs * (1 + jitterRatio * (2 * x - 1)));
    expect(r.schedule.armed.map((a) => [a.timer, a.delayMs])).toEqual([['tick', delay(0)]]);
    const answers = [
      result({
        processed: 3,
        finalized: 2,
        skipped: { running: 1, held: 0 },
        nextCursor: cursorA,
        wrapped: false,
      }),
      result({ processed: 1, finalized: 1, failed: 0, nextCursor: cursorB, wrapped: false }),
    ];
    r.sweeper.answer = () => {
      r.clock.advanceMs(1_234);
      return Promise.resolve(answers.shift()!);
    };

    await r.schedule.fire('tick');
    expect(r.schedule.pending('tick').map((a) => a.delayMs)).toEqual([delay(0.75)]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    await r.schedule.fire('tick');
    expect(r.schedule.pending('tick').map((a) => a.delayMs)).toEqual([delay(0.999_999)]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    expect(r.sweeper.cursors).toEqual([sweepStart(), cursorA]);
    const ticks = r.logs.of('agent_sweep_tick');
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({
      level: LEVEL.info,
      processed: 3,
      finalized: 2,
      skipped_running: 1,
      skipped_held: 0,
      failed: 0,
      wrapped: false,
      duration_ms: 1_234,
    });
    expect(ticks[1]).toMatchObject({ processed: 1, finalized: 1, duration_ms: 1_234 });
    for (const a of r.schedule.armed.filter((x) => x.timer === 'tick')) {
      expect(a.delayMs).toBeGreaterThanOrEqual(intervalMs * (1 - jitterRatio));
      expect(a.delayMs).toBeLessThanOrEqual(intervalMs * (1 + jitterRatio));
    }
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#9] 一轮里 sweepOnce 抛错：记 error agent_sweep_failed（只记错误名，不记消息）、锁照样释放、游标不变；下一轮照常', async () => {
  const r = rig();
  try {
    let calls = 0;
    r.sweeper.answer = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('用户原话 13800138000 不得入日志'));
      return Promise.resolve(result({ processed: 0 }));
    };
    await r.schedule.fire('tick');
    expect(r.logs.of('agent_sweep_failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, error_name: 'TypeError' }),
    ]);
    expect(r.logs.lines.join('\n')).not.toContain('13800138000');
    expect(await advisoryHolders(pg.db)).toEqual([]);
    expect(r.schedule.pending('tick')).toHaveLength(1);

    await r.schedule.fire('tick');
    expect(r.sweeper.cursors).toEqual([sweepStart(), sweepStart()]);
    expect(r.logs.of('agent_sweep_tick')).toHaveLength(1);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#10] 持锁连接被 pg_terminate_backend 杀掉：锁随连接自动释放，另一 worker 下一轮拿到锁接管；原 worker 本轮记 agent_sweep_lock_failed、不抛，下一轮照常', async () => {
  const a = rig();
  const b = rig();
  try {
    const tickA = a.schedule.fire('tick');
    await a.sweeper.started(1);
    const holders = await advisoryHolders(pg.db);
    expect(holders).toHaveLength(1);
    await terminate(pg.db, holders[0]!);
    await until(
      'the killed backend released its lock',
      async () => (await advisoryHolders(pg.db)).length === 0,
    );

    b.sweeper.answer = () => Promise.resolve(result({ processed: 0 }));
    await b.schedule.fire('tick');
    expect(b.sweeper.cursors).toHaveLength(1);
    expect(b.logs.of('agent_sweep_tick')).toHaveLength(1);
    expect(b.logs.of('agent_sweep_skipped')).toEqual([]);

    a.sweeper.pending[0]!.resolve(result({ processed: 0 }));
    await tickA;
    expect(a.logs.of('agent_sweep_lock_failed')).toEqual([
      expect.objectContaining({ level: LEVEL.error, error_name: expect.any(String) }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    a.sweeper.answer = () => Promise.resolve(result({ processed: 0 }));
    await a.schedule.fire('tick');
    expect(a.sweeper.cursors).toHaveLength(2);
    expect(a.logs.of('agent_sweep_tick').length).toBeGreaterThanOrEqual(1);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    for (const p of a.sweeper.pending) p.resolve(result());
    await a.loop.stop();
    await b.loop.stop();
  }
});

it('[AC-B3-03h#11] running 期间再次触发不并发：第二次 tick 记 agent_sweep_skipped busy 后立即结束，不借连接、不调 sweepOnce；前一轮照常结束并释放锁', async () => {
  const r = rig();
  try {
    const first = r.schedule.fire('tick');
    await r.sweeper.started(1);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);
    await r.schedule.fire('tick');
    expect(r.sweeper.cursors).toHaveLength(1);
    expect(r.logs.of('agent_sweep_skipped')).toEqual([expect.objectContaining({ reason: 'busy' })]);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);

    r.sweeper.pending[0]!.resolve(result({ processed: 2, finalized: 2 }));
    await first;
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 2, finalized: 2 }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
    expect(r.schedule.pending('tick')).toHaveLength(1);
  } finally {
    for (const p of r.sweeper.pending) p.resolve(result());
    await r.loop.stop();
  }
});

it('[AC-B3-03h#12] 单轮时限：sweepOnce 挂起超过 tickTimeoutMs → 记 warn agent_sweep_timeout、本轮结束并释放锁、游标不变；迟到的结果或拒绝被忽略；后续轮不受影响', async () => {
  const r = rig();
  try {
    const tick = r.schedule.fire('tick');
    await r.sweeper.started(1);
    await until(
      'the tick time limit is armed',
      () => r.schedule.pending('tick_timeout').length === 1,
    );
    expect(r.schedule.pending('tick_timeout')[0]!.delayMs).toBe(r.config.tickTimeoutMs);
    await r.schedule.fire('tick_timeout');
    await tick;
    expect(r.logs.of('agent_sweep_timeout')).toEqual([
      expect.objectContaining({ level: LEVEL.warn, timeout_ms: r.config.tickTimeoutMs }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    // The abandoned pass rejects late: ignored, never an unhandled rejection.
    r.sweeper.pending[0]!.reject(new Error('late'));
    r.sweeper.answer = () =>
      Promise.resolve(result({ processed: 1, finalized: 1, nextCursor: cursorA, wrapped: false }));
    await r.schedule.fire('tick');
    expect(r.sweeper.cursors).toEqual([sweepStart(), sweepStart()]);
    expect(r.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 1, finalized: 1 }),
    ]);
    expect(r.logs.of('agent_sweep_failed')).toEqual([]);
    expect(await advisoryHolders(pg.db)).toEqual([]);
  } finally {
    await r.loop.stop();
  }
});

it('[AC-B3-03h#13] stop：等进行中的一轮结束才 resolve（锁已释放）；取消已排的 tick，停后迟到的 tick 什么都不做；重复调用都 resolve', async () => {
  const r = rig();
  const tick = r.schedule.fire('tick');
  await r.sweeper.started(1);
  const armedTick = r.schedule.pending('tick')[0]!;
  let stopped = false;
  const stopping = r.loop.stop().then(() => (stopped = true));
  await until('stop arms its upper bound', () => r.schedule.pending('stop_timeout').length === 1);
  expect(r.schedule.pending('stop_timeout')[0]!.delayMs).toBe(r.config.stopTimeoutMs);
  expect(stopped).toBe(false);
  expect(armedTick.cancelled).toBe(true);

  r.sweeper.pending[0]!.resolve(result());
  await tick;
  await stopping;
  expect(await advisoryHolders(pg.db)).toEqual([]);

  await r.schedule.fireLate(armedTick);
  expect(r.sweeper.cursors).toHaveLength(1);
  await expect(r.loop.stop()).resolves.toBeUndefined();
  expect(r.schedule.pending('tick')).toEqual([]);
});

it('[AC-B3-03h#14] stop 的等待有上限：进行中的一轮挂起时 stop_timeout 触发即 resolve；之后不再起新一轮', async () => {
  const r = rig();
  const tick = r.schedule.fire('tick');
  await r.sweeper.started(1);
  const stopping = r.loop.stop();
  await until('stop arms its upper bound', () => r.schedule.pending('stop_timeout').length === 1);
  await r.schedule.fire('stop_timeout');
  await stopping;
  expect(r.schedule.pending('tick')).toEqual([]);

  // The hung pass ends later on its own time limit; the lock is released, nothing else starts.
  await until(
    'the tick time limit is armed',
    () => r.schedule.pending('tick_timeout').length === 1,
  );
  await r.schedule.fire('tick_timeout');
  await tick;
  r.sweeper.pending[0]!.resolve(result());
  expect(await advisoryHolders(pg.db)).toEqual([]);
  expect(r.sweeper.cursors).toHaveLength(1);
  expect(r.schedule.pending('tick')).toEqual([]);
});
