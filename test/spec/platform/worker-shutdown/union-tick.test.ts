// B2-15q rule test (claude-independent, D10-553): union's chain timer. Its tick has no catch around
// monitor.heal(), and the timer starts it with `void tick()`, so a failed heal is an unhandled
// rejection of the worker process. A failed heal must be a warn line and the next tick must run.
// The listener below also keeps Vitest from reporting the rejection on the old module as an error of
// the run: the red is the assertion on `rejections`. Top-level it() only (规划/11 §4.3).
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  LOAD_TIMEOUT_MS,
  drain,
  fakeModuleTimers,
  loadUnionTarget,
  recordingLogger,
  stopping,
  syntheticError,
  type UnionTarget,
} from './kit.ts';

let target: UnionTarget;
let rejections: unknown[] = [];

function onRejection(reason: unknown): void {
  rejections.push(reason);
}

beforeAll(async () => {
  target = await loadUnionTarget();
}, LOAD_TIMEOUT_MS);

beforeEach(() => {
  rejections = [];
  process.on('unhandledRejection', onRejection);
  fakeModuleTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.off('unhandledRejection', onRejection);
});

it('[AC-B2-15q#6] union：tick 里 heal 失败时记 warn，不产生未处理 rejection，下一次 tick 照常运行', async () => {
  const heal = vi.fn(() => Promise.reject(syntheticError('SyntheticHealError')));
  const { logger, warnings } = recordingLogger();
  const timer = target.build({ seed: () => Promise.resolve(), heal }, logger);

  timer.onApplicationBootstrap();
  vi.advanceTimersByTime(target.seedDelayMs);
  await drain();
  expect(heal).toHaveBeenCalledTimes(1);
  expect(rejections, 'a failed heal became an unhandled rejection').toStrictEqual([]);
  expect(warnings()).toContainEqual(
    expect.objectContaining({
      fields: expect.objectContaining({
        queue: 'union-auth',
        error_name: 'SyntheticHealError',
      }),
    }),
  );

  vi.advanceTimersByTime(target.healIntervalMs);
  await drain();
  expect(heal).toHaveBeenCalledTimes(2);
  expect(rejections).toStrictEqual([]);
  expect(await stopping(timer).settled()).toBe('returned');
});

it('[AC-B2-15q#7] union：seed 与 heal 同一 tick 都失败时各记一条 warn，不产生未处理 rejection', async () => {
  const { logger, warnings } = recordingLogger();
  const timer = target.build(
    {
      seed: () => Promise.reject(syntheticError('SyntheticSeedError')),
      heal: () => Promise.reject(syntheticError('SyntheticHealError')),
    },
    logger,
  );

  timer.onApplicationBootstrap();
  vi.advanceTimersByTime(target.seedDelayMs);
  await drain();
  expect(rejections, 'a failed heal became an unhandled rejection').toStrictEqual([]);
  expect(warnings().map((line) => line.fields['error_name'])).toStrictEqual([
    'SyntheticSeedError',
    'SyntheticHealError',
  ]);
  expect(await stopping(timer).settled()).toBe('returned');
});
