// B3-03h 第 9 节 5（不连库部分）：循环参数（设计 §10.1 T10：周期 60 s ± 10 %、单轮时限 60 s；可注入覆盖，
// 不读 process.env）、参数校验、启动时同步什么都不做、默认 schedule 用 unref 的 setTimeout、stop 幂等且停后
// 不再 tick。数据库句柄是一个只计数的替身：这里的用例一次连接都不该借。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  agentSweepLoopDefaults,
  startAgentSweeper,
  type AgentSweepLoopConfig,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import { Logs, ManualSchedule, START_MS, ScriptedSweeper } from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

function untouchedDb(): { db: Kysely<DB>; touched: () => number } {
  let touched = 0;
  const db = new Proxy(
    {},
    {
      get() {
        touched += 1;
        throw new Error('the database must not be used here');
      },
    },
  ) as Kysely<DB>;
  return { db, touched: () => touched };
}

function start(config: AgentSweepLoopConfig, schedule?: ManualSchedule, random?: () => number) {
  const { db, touched } = untouchedDb();
  const sweeper = new ScriptedSweeper();
  const logs = new Logs();
  const loop = startAgentSweeper({
    sweeper,
    db,
    clock: new FixedClock(new Date(START_MS)),
    logger: logs.logger,
    config,
    ...(schedule === undefined ? {} : { schedule: schedule.schedule }),
    ...(random === undefined ? {} : { random }),
  });
  return { loop, sweeper, logs, touched };
}

it('[AC-B3-03h#15] 默认参数：周期 60 s、抖动 ±10 %、单轮时限 60 s，stop 等待上限为正的安全整数；每次调用返回新对象', () => {
  const d = agentSweepLoopDefaults();
  expect(d).toMatchObject({ intervalMs: 60_000, jitterRatio: 0.1, tickTimeoutMs: 60_000 });
  expect(Number.isSafeInteger(d.stopTimeoutMs) && d.stopTimeoutMs >= 1).toBe(true);
  expect(Object.keys(d).sort()).toEqual([
    'intervalMs',
    'jitterRatio',
    'stopTimeoutMs',
    'tickTimeoutMs',
  ]);
  expect(agentSweepLoopDefaults()).not.toBe(d);
  expect(agentSweepLoopDefaults()).toEqual(d);
});

it('[AC-B3-03h#16] 参数校验：interval / tickTimeout / stopTimeout 须为 ≥ 1 的安全整数、0 ≤ jitterRatio < 1，否则 startAgentSweeper 抛 RangeError 且不排任何定时器；抖动 0 合法', () => {
  const base = agentSweepLoopDefaults();
  const invalid: [string, AgentSweepLoopConfig][] = [
    ['interval 0', { ...base, intervalMs: 0 }],
    ['interval 1.5', { ...base, intervalMs: 1.5 }],
    ['interval NaN', { ...base, intervalMs: Number.NaN }],
    ['jitter -0.1', { ...base, jitterRatio: -0.1 }],
    ['jitter 1', { ...base, jitterRatio: 1 }],
    ['jitter NaN', { ...base, jitterRatio: Number.NaN }],
    ['tickTimeout 0', { ...base, tickTimeoutMs: 0 }],
    ['tickTimeout Infinity', { ...base, tickTimeoutMs: Number.POSITIVE_INFINITY }],
    ['stopTimeout 0', { ...base, stopTimeoutMs: 0 }],
    ['stopTimeout 2.5', { ...base, stopTimeoutMs: 2.5 }],
  ];
  for (const [label, config] of invalid) {
    const schedule = new ManualSchedule();
    expect(() => start(config, schedule), label).toThrow(RangeError);
    expect(schedule.armed, label).toEqual([]);
  }
  const schedule = new ManualSchedule();
  const ok = start({ ...base, jitterRatio: 0 }, schedule, () => 0.9);
  expect(schedule.armed.map((a) => [a.timer, a.delayMs])).toEqual([['tick', base.intervalMs]]);
  void ok.loop.stop();
});

it('[AC-B3-03h#17] 启动只排第一轮 tick：不同步借连接、不调 sweepOnce；抖动边界内（random 取 0 与接近 1）', async () => {
  const base = agentSweepLoopDefaults();
  for (const r of [0, 0.5, 0.999_999]) {
    const schedule = new ManualSchedule();
    const s = start(base, schedule, () => r);
    expect(s.touched()).toBe(0);
    expect(s.sweeper.cursors).toEqual([]);
    expect(schedule.armed).toHaveLength(1);
    const [armed] = schedule.armed;
    expect(armed!.timer).toBe('tick');
    expect(armed!.delayMs).toBe(Math.round(base.intervalMs * (1 + base.jitterRatio * (2 * r - 1))));
    expect(armed!.delayMs).toBeGreaterThanOrEqual(base.intervalMs * (1 - base.jitterRatio));
    expect(armed!.delayMs).toBeLessThanOrEqual(base.intervalMs * (1 + base.jitterRatio));
    await s.loop.stop();
  }
});

it('[AC-B3-03h#18] 默认 schedule：一个 unref 的 setTimeout（不单独撑住进程）；stop 后不留定时器', async () => {
  vi.useFakeTimers();
  const unref = vi.fn();
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    const handle = real(fn, ms);
    const original = handle.unref?.bind(handle);
    (handle as { unref: () => unknown }).unref = () => {
      unref();
      return original?.();
    };
    return handle;
  }) as typeof setTimeout);
  const s = start(agentSweepLoopDefaults());
  expect(spy).toHaveBeenCalledTimes(1);
  expect(unref).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await s.loop.stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(s.touched()).toBe(0);
});

it('[AC-B3-03h#19] stop 幂等：没有进行中的一轮时立即 resolve、取消已排的 tick；多次调用都 resolve；停后迟到触发的 tick 不借连接、不调 sweepOnce、不再排下一轮', async () => {
  const schedule = new ManualSchedule();
  const s = start(agentSweepLoopDefaults(), schedule);
  const armed = schedule.armed[0]!;
  await expect(s.loop.stop()).resolves.toBeUndefined();
  expect(armed.cancelled).toBe(true);
  await expect(Promise.all([s.loop.stop(), s.loop.stop()])).resolves.toEqual([
    undefined,
    undefined,
  ]);
  await schedule.fireLate(armed);
  expect(s.touched()).toBe(0);
  expect(s.sweeper.cursors).toEqual([]);
  expect(schedule.armed).toHaveLength(1);
  expect(s.logs.of('agent_sweep_tick')).toEqual([]);
});
