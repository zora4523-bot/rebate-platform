// B2-15q rule test (claude-independent, D10-553): the worker's background ticks and the shutdown.
// A stop waits for the tick in flight, as catalog-worker.module.ts does; the process closes its
// database only after the stop, so no tick is left to touch a pool being closed. Over kit.ts: the
// real timers and tick functions on a gated pool, fake module timers (no real 15 s wait), every wait
// bounded (kit within), so a stop that hangs fails an assertion and never hangs Vitest.
//
// #1 and #2 are red on the old modules because a stop returns at once. #3 and #4 also pin what the
// old modules partly do already (a timer not due yet is cleared; ledger refuses a bootstrap after a
// stop). Those parts run first and are checked on the old code too; the same tests then end in a
// part the old code fails: #3 on the order of the stop and the tick, #4 on a bootstrap after a stop
// (payment, payout) or on the stop in the turn a tick starts (ledger). Top-level it() only
// (规划/11 §4.3).
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  LOAD_TIMEOUT_MS,
  TIMERS,
  drain,
  fakeModuleTimers,
  loadTargets,
  rigOf,
  stopping,
  syntheticError,
  type Rig,
  type Target,
  type TimerName,
} from './kit.ts';

let targets: Record<TimerName, Target>;

beforeAll(async () => {
  targets = await loadTargets();
}, LOAD_TIMEOUT_MS);

beforeEach(() => {
  fakeModuleTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Bootstraps a timer and lets its first tick start and reach the gated pool. */
async function tickHeldInFlight(target: Target): Promise<Rig> {
  const rig = rigOf(target);
  rig.timer.onApplicationBootstrap();
  vi.advanceTimersByTime(target.seedDelayMs);
  await drain();
  expect(rig.pool.waiting(), 'fixture: the first tick is held at the pool').toBe(1);
  return rig;
}

it.each(TIMERS)(
  '[AC-B2-15q#1] %s：tick 在途时 onModuleDestroy 不返回，tick 结束后才返回',
  async (name) => {
    const rig = await tickHeldInFlight(targets[name]);

    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop returned with a tick still in flight').toBe('pending');

    rig.pool.open();
    expect(await stop.settled(), 'the stop did not return after the tick ended').toBe('returned');
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#2] %s：在途 tick 失败时 onModuleDestroy 同样等它结束后正常返回，错误只记 warn，不抛给关停',
  async (name) => {
    const target = targets[name];
    const rig = await tickHeldInFlight(target);

    const stop = stopping(rig.timer);
    await drain();
    expect(stop.outcome(), 'the stop returned with a tick still in flight').toBe('pending');

    rig.pool.fail(syntheticError('SyntheticPoolError'));
    expect(await stop.settled(), 'a failed tick must not fail the shutdown').toBe('returned');
    expect(rig.warnings()).toContainEqual(
      expect.objectContaining({
        message: target.failureLine,
        fields: expect.objectContaining({ error_name: 'SyntheticPoolError' }),
      }),
    );
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#3] %s：首个定时器未到点就 stop，tick 永不运行；tick 在途时 stop，tick 结束后才返回，之后到点的定时器不再起新 tick',
  async (name) => {
    const target = targets[name];

    const notDue = rigOf(target);
    notDue.timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs - 1);
    expect(await stopping(notDue.timer).settled()).toBe('returned');
    vi.advanceTimersByTime(target.seedDelayMs + target.healIntervalMs * 3);
    await drain();
    expect(notDue.pool.connects(), 'a tick ran after the stop').toBe(0);

    const log: string[] = [];
    const rig = await tickHeldInFlight(target);
    log.push('stop_called');
    const stop = stopping(rig.timer, log);
    await drain();
    log.push('tick_released');
    rig.pool.open();
    expect(await stop.settled()).toBe('returned');
    await drain();
    const statements = rig.pool.connects();
    vi.advanceTimersByTime(target.healIntervalMs * 3);
    await drain();
    expect(rig.pool.connects(), 'a tick ran after the stop').toBe(statements);
    expect(log, 'the stop must return after the tick ended').toStrictEqual([
      'stop_called',
      'tick_released',
      'stop_returned',
    ]);
  },
);

it.each(TIMERS)(
  '[AC-B2-15q#4] %s：起跑前已 stop：bootstrap 后立刻 stop、stop 之后才 bootstrap，tick 都不运行；定时器到点的同一轮 stop，返回时不留在途',
  async (name) => {
    const target = targets[name];

    const early = rigOf(target);
    early.timer.onApplicationBootstrap();
    expect(await stopping(early.timer).settled()).toBe('returned');
    vi.advanceTimersByTime(target.seedDelayMs + target.healIntervalMs * 3);
    await drain();
    expect(early.pool.connects(), 'a tick ran after the stop').toBe(0);

    const late = rigOf(target);
    expect(await stopping(late.timer).settled()).toBe('returned');
    late.timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs + target.healIntervalMs * 3);
    await drain();
    expect(late.pool.connects(), 'a tick ran after the stop').toBe(0);

    const racing = rigOf(target);
    racing.timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs);
    const stop = stopping(racing.timer);
    await drain();
    expect(stop.outcome(), 'the stop returned with the tick it raced in flight').toBe('pending');
    racing.pool.open();
    expect(await stop.settled()).toBe('returned');
    expect(racing.pool.waiting(), 'the stop left a statement in flight').toBe(0);
  },
);
