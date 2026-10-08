import { afterEach, expect, it, vi } from 'vitest';
import type {
  ClaimedJob,
  fetchAttempt,
  settleAttempt,
} from '../../../../apps/api/src/modules/platform/queue/attempt.ts';
import {
  runExecutor,
  type ExecutorOptions,
} from '../../../../apps/api/src/modules/platform/queue/executor.ts';

// Exercise the real execution loop; only the database claim/settlement boundary is fake.
// Virtual time makes the polling contract independent of container load.
const attempts = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetchAttempt>(),
  settle: vi.fn<typeof settleAttempt>(),
}));
vi.mock('../../../../apps/api/src/modules/platform/queue/attempt.ts', () => ({
  fetchAttempt: attempts.fetch,
  settleAttempt: attempts.settle,
}));

const INTERVAL_MS = 2000;
const BURST_SIZE = 6;
const BURST_BOUND_MS = 3500; // Strictly less than two intervals, versus five waits before the fix.
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.useRealTimers();
  }
});

function job(index: number): ClaimedJob {
  const created = new Date('2026-10-09T00:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: 'notify',
    data: { name: 'throughput.demo', payload: {} },
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryCount: 0,
    retryLimit: 0,
    retryDelay: 1,
    retryBackoff: false,
    expireInSeconds: 60,
    heartbeatSeconds: null,
    startAfter: created,
    startedOn: created,
    startedOnExact: '2026-10-09 00:00:00+00',
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 60,
    createdOn: created,
    completedOn: null,
    keepUntil: new Date('2026-10-10T00:00:00.000Z'),
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: 'dead-letter',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  };
}

function fixture(handlerDelayMs = 0) {
  vi.useFakeTimers({ now: 0 });
  attempts.fetch.mockReset();
  attempts.settle.mockReset();
  const shutdown = new AbortController();
  const deadline = new AbortController();
  const pending: ClaimedJob[] = [];
  const failures: Error[] = [];
  const fetchTimes: number[] = [];
  const completed: string[] = [];
  const handled: string[] = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  attempts.fetch.mockImplementation(async () => {
    fetchTimes.push(Date.now());
    // Bound even a broken busy loop so it fails assertions instead of starving the test runner.
    if (fetchTimes.length > 100) {
      shutdown.abort();
      return [];
    }
    const failure = failures.shift();
    if (failure) throw failure;
    return pending.splice(0, 1);
  });
  attempts.settle.mockImplementation(async (_db, _boss, _queue, received, succeeded) => {
    if (succeeded) completed.push(received.id);
    return true;
  });
  const options: ExecutorOptions = {
    // Never used by the mocked claim/settlement boundary; no database or pg-boss is created.
    db: {} as ExecutorOptions['db'],
    boss: {} as ExecutorOptions['boss'],
    logger: logger as unknown as ExecutorOptions['logger'],
    work: { queue: 'notify', concurrency: 1, pollingIntervalSeconds: INTERVAL_MS / 1000 },
    handler: async (received) => {
      handled.push(received.id);
      if (handlerDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, handlerDelayMs));
      }
    },
    shutdown: shutdown.signal,
    deadline: deadline.signal,
    runningHandlers: new Set(),
  };
  let execution: Promise<void> | undefined;
  let stopped = false;
  cleanups.push(async () => {
    shutdown.abort();
    deadline.abort();
    await vi.advanceTimersByTimeAsync(handlerDelayMs);
    await execution;
  });
  return {
    pending,
    failures,
    fetchTimes,
    completed,
    handled,
    logger,
    shutdown,
    stopped: () => stopped,
    start() {
      execution = runExecutor(options).then(() => {
        stopped = true;
      });
    },
  };
}

// Poll terminal state within a virtual-time budget; a missed target is an assertion failure.
async function reaches(ready: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs;
  await vi.advanceTimersByTimeAsync(0);
  while (!ready() && Date.now() < end) {
    await vi.advanceTimersByTimeAsync(Math.min(25, end - Date.now()));
  }
  return ready();
}

it('[AC-B1-01zg#1] 单通道连续处理六个积压任务，总耗时小于两个轮询间隔', async () => {
  const lane = fixture();
  const burst = Array.from({ length: BURST_SIZE }, (_, i) => job(i + 1));
  lane.pending.push(...burst);
  const started = Date.now();
  lane.start();
  expect(await reaches(() => lane.completed.length === BURST_SIZE, BURST_BOUND_MS)).toBe(true);
  expect(lane.completed).toEqual(burst.map((item) => item.id));
  expect(Date.now() - started).toBeLessThan(2 * INTERVAL_MS);
  expect(lane.logger.error).not.toHaveBeenCalled();
}, 30_000);

it('[AC-B1-01zg#2] 连续取空各等一个间隔，再有积压时立即连续处理，排空后恢复等待', async () => {
  const lane = fixture();
  lane.start();
  expect(await reaches(() => lane.fetchTimes.length === 1, 100)).toBe(true);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(lane.fetchTimes).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(lane.fetchTimes).toEqual([0, INTERVAL_MS]);
  lane.pending.push(...Array.from({ length: BURST_SIZE }, (_, i) => job(i + 1)));
  await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(lane.fetchTimes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(lane.fetchTimes[2]! - lane.fetchTimes[1]!).toBeGreaterThanOrEqual(INTERVAL_MS);
  expect(await reaches(() => lane.completed.length === BURST_SIZE, BURST_BOUND_MS)).toBe(true);
  // Wait for the first empty fetch after the burst, then inspect its entire waiting window.
  expect(await reaches(() => lane.fetchTimes.length >= 2 + BURST_SIZE + 1, 100)).toBe(true);
  const count = lane.fetchTimes.length;
  const lastEmpty = lane.fetchTimes[count - 1]!;
  await vi.advanceTimersByTimeAsync(lastEmpty + INTERVAL_MS - 1 - Date.now());
  expect(lane.fetchTimes).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(lane.fetchTimes).toHaveLength(count + 1);
  expect(lane.fetchTimes[count]! - lastEmpty).toBeGreaterThanOrEqual(INTERVAL_MS);
  expect(lane.logger.error).not.toHaveBeenCalled();
}, 30_000);

it('[AC-B1-01zg#3] 连续领取失败每次报告 queue_error 并等待，恢复后立即处理积压', async () => {
  const lane = fixture();
  lane.pending.push(...Array.from({ length: BURST_SIZE }, (_, i) => job(i + 1)));
  lane.failures.push(
    Object.assign(new Error('demo claim failure'), { code: 'DEMO_FETCH_1' }),
    Object.assign(new Error('demo claim failure'), { code: 'DEMO_FETCH_2' }),
  );
  lane.start();
  expect(await reaches(() => lane.logger.error.mock.calls.length === 1, 100)).toBe(true);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(lane.fetchTimes).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(lane.fetchTimes).toEqual([0, INTERVAL_MS]);
  expect(lane.logger.error.mock.calls).toEqual([
    [{ code: 'DEMO_FETCH_1' }, 'queue_error'],
    [{ code: 'DEMO_FETCH_2' }, 'queue_error'],
  ]);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
  expect(lane.fetchTimes).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(lane.fetchTimes[2]! - lane.fetchTimes[1]!).toBeGreaterThanOrEqual(INTERVAL_MS);
  expect(await reaches(() => lane.completed.length === BURST_SIZE, BURST_BOUND_MS)).toBe(true);
  expect(lane.logger.error).toHaveBeenCalledTimes(2);
}, 30_000);

it('[AC-B1-01zg#4] 连续再取期间外部停止信号及时结束通道，停止后不再领取', async () => {
  // Each handler yields for 10 ms, allowing an external stop during the fourth job.
  const lane = fixture(10);
  lane.pending.push(...Array.from({ length: 50 }, (_, i) => job(i + 1)));
  lane.start();
  setTimeout(() => lane.shutdown.abort(), 35);
  expect(await reaches(lane.stopped, 100)).toBe(true);
  expect(lane.shutdown.signal.aborted).toBe(true);
  expect(lane.handled).toHaveLength(4);
  expect(lane.completed).toHaveLength(4);
  expect(lane.fetchTimes).toHaveLength(4);
  expect(lane.fetchTimes.every((time) => time < 35)).toBe(true);
  await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS);
  expect(lane.fetchTimes).toHaveLength(4);
  expect(lane.pending).toHaveLength(46);
  expect(lane.logger.error).not.toHaveBeenCalled();
}, 30_000);
