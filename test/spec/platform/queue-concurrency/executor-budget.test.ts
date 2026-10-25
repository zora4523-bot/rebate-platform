// B1-01zzk 全局预算 at the lane level (contract section 12 of
// apps/api/src/modules/platform/queue/index.ts; ExecutorOptions.permits). Lanes of different queues
// share one permit pool: a lane takes a permit BEFORE it fetches, so the jobs beyond the budget stay
// unclaimed in their queue (no expiry, retry or attempt used), and it returns the permit after the
// settlement or right after an empty or failed fetch. The real execution loop runs; only the
// database claim / settlement boundary (attempt.ts) is fake, and time is virtual.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
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
import {
  createPermits,
  type Permits,
} from '../../../../apps/api/src/modules/platform/queue/permits.ts';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/queue/types.ts';

const attempts = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetchAttempt>(),
  settle: vi.fn<typeof settleAttempt>(),
}));
vi.mock('../../../../apps/api/src/modules/platform/queue/attempt.ts', () => ({
  fetchAttempt: attempts.fetch,
  settleAttempt: attempts.settle,
}));

const INTERVAL_MS = 2000;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    vi.useRealTimers();
  }
});

function job(queue: string, index: number): ClaimedJob {
  const created = new Date('2026-10-26T00:00:00.000Z');
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: queue,
    data: { name: 'budget.demo', payload: { index } },
    signal: new AbortController().signal,
    priority: 0,
    state: 'active',
    retryCount: 0,
    retryLimit: 2,
    retryDelay: 1,
    retryBackoff: false,
    expireInSeconds: 60,
    heartbeatSeconds: null,
    startAfter: created,
    startedOn: created,
    startedOnExact: '2026-10-26 00:00:00+00',
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 60,
    createdOn: created,
    completedOn: null,
    keepUntil: new Date('2026-10-27T00:00:00.000Z'),
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: 'test-dead',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
  };
}

/** Lanes over a fake claim boundary: `pending[queue]` is what each fetch of that queue takes. */
function harness(permits: Permits) {
  vi.useFakeTimers({ now: 0 });
  attempts.fetch.mockReset();
  attempts.settle.mockReset();
  const shutdown = new AbortController();
  const deadline = new AbortController();
  const pending: Record<string, ClaimedJob[]> = {};
  const failures: Record<string, Error[]> = {};
  const fetches: Array<{ queue: string; at: number; running: number }> = [];
  const settled: Array<{ id: string; succeeded: boolean; retryCount: number }> = [];
  const attemptsSeen: number[] = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  let running = 0;
  let peak = 0;
  attempts.fetch.mockImplementation(async (_db, _boss, queue) => {
    fetches.push({ queue, at: Date.now(), running });
    // Bound even a broken busy loop so it fails assertions instead of starving the test runner.
    if (fetches.length > 400) {
      shutdown.abort();
      return [];
    }
    const failure = failures[queue]?.shift();
    if (failure) throw failure;
    return (pending[queue] ?? []).splice(0, 1);
  });
  attempts.settle.mockImplementation(async (_db, _boss, _queue, received, succeeded) => {
    settled.push({ id: received.id, succeeded, retryCount: received.retryCount });
    return true;
  });
  /** A handler that counts running calls and holds for `holdMs` (or until `until` resolves). */
  const handler =
    (holdMs: number, until?: Promise<void>): JobHandler =>
    async (received) => {
      attemptsSeen.push(received.attempt);
      running += 1;
      peak = Math.max(peak, running);
      try {
        if (until !== undefined) await until;
        else await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
      } finally {
        running -= 1;
      }
    };
  const lanes: Promise<void>[] = [];
  let stoppedLanes = 0;
  const lane = (queue: string, laneHandler: JobHandler) => {
    const options: ExecutorOptions = {
      // Never used by the mocked claim/settlement boundary; no database or pg-boss is created.
      db: {} as ExecutorOptions['db'],
      boss: {} as ExecutorOptions['boss'],
      logger: logger as unknown as ExecutorOptions['logger'],
      work: { queue, concurrency: 1, pollingIntervalSeconds: INTERVAL_MS / 1000 },
      handler: laneHandler,
      shutdown: shutdown.signal,
      deadline: deadline.signal,
      runningHandlers: new Set(),
      permits,
    };
    lanes.push(
      runExecutor(options).then(() => {
        stoppedLanes += 1;
      }),
    );
  };
  cleanups.push(async () => {
    shutdown.abort();
    deadline.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.allSettled(lanes);
  });
  return {
    pending,
    failures,
    fetches,
    settled,
    attemptsSeen,
    logger,
    shutdown,
    handler,
    lane,
    running: () => running,
    peak: () => peak,
    stoppedLanes: () => stoppedLanes,
  };
}

// Advance virtual time in small steps until `ready` or `limitMs` of virtual time passed.
async function reaches(ready: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs;
  await vi.advanceTimersByTimeAsync(0);
  while (!ready() && Date.now() < end) {
    await vi.advanceTimersByTimeAsync(Math.min(10, end - Date.now()));
  }
  return ready();
}

it('[B1-01zzk 全局预算] 三条通道（两个队列）共享预算 2：同时在跑的处理器不超过 2 且确实到 2；每次领取时在跑的不超过 1（先拿许可再领取）；8 个任务全部完成、各结算一次、attempt 都是 1、retryCount 不变；排空后许可全部归还', async () => {
  const permits = createPermits(2);
  const h = harness(permits);
  h.pending['c-a'] = [1, 2, 3, 4].map((index) => job('c-a', index));
  h.pending['c-b'] = [5, 6, 7, 8].map((index) => job('c-b', index));
  h.lane('c-a', h.handler(100));
  h.lane('c-a', h.handler(130));
  h.lane('c-b', h.handler(70));
  const done = await reaches(() => h.settled.length === 8, 3000);
  await vi.advanceTimersByTimeAsync(50);
  const seen = {
    done,
    peak: h.peak(),
    // The fetching lane holds one of the 2 permits: at most 1 handler can be running meanwhile.
    fetchesOverBudget: h.fetches.filter((fetch) => fetch.running > 1).length,
    settled: h.settled
      .map((item) => `${item.id.slice(-2)}:${String(item.succeeded)}:${String(item.retryCount)}`)
      .sort(),
    attempts: [...new Set(h.attemptsSeen)],
    heldAfter: permits.held(),
    errors: h.logger.error.mock.calls.length,
  };
  expect(seen).toStrictEqual({
    done: true,
    peak: 2,
    fetchesOverBudget: 0,
    settled: ['01', '02', '03', '04', '05', '06', '07', '08'].map((id) => `${id}:true:0`),
    attempts: [1],
    heldAfter: 0,
    errors: 0,
  });
}, 30_000);

it('[B1-01zzk 全局预算] 空取或领取失败后立即归还许可：预算 1 时空队列与报错队列的通道不霸占许可，另一队列的 3 个任务在一个轮询间隔内做完；领取失败照常报 queue_error', async () => {
  const permits = createPermits(1);
  const h = harness(permits);
  h.failures['c-b'] = [Object.assign(new Error('demo claim failure'), { code: 'DEMO_FETCH' })];
  h.pending['c-c'] = [1, 2, 3].map((index) => job('c-c', index));
  h.lane('c-a', h.handler(100));
  h.lane('c-b', h.handler(100));
  h.lane('c-c', h.handler(100));
  const done = await reaches(() => h.settled.length === 3, INTERVAL_MS - 200);
  await vi.advanceTimersByTimeAsync(50);
  expect({
    done,
    peak: h.peak(),
    heldAfter: permits.held(),
    errors: h.logger.error.mock.calls,
  }).toStrictEqual({
    done: true,
    peak: 1,
    heldAfter: 0,
    errors: [[{ code: 'DEMO_FETCH' }, 'queue_error']],
  });
}, 30_000);

it('[B1-01zzk 全局预算; 停止] 拿不到许可的通道不领取任务；停止信号让它立即结束且不再领取，正在跑的任务照常结算，另一队列的任务留在队列里', async () => {
  const permits = createPermits(1);
  const h = harness(permits);
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  h.pending['c-a'] = [job('c-a', 1)];
  h.pending['c-b'] = [job('c-b', 2)];
  h.lane('c-a', h.handler(0, gate));
  h.lane('c-b', h.handler(0));
  const holding = await reaches(() => h.running() === 1, 500);
  await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
  const before = {
    holding,
    fetched: h.fetches.map((fetch) => fetch.queue),
    waiting: permits.waiting(),
  };
  h.shutdown.abort();
  await vi.advanceTimersByTimeAsync(10);
  const afterStop = {
    stoppedLanes: h.stoppedLanes(),
    fetched: h.fetches.length,
    waiting: permits.waiting(),
  };
  open();
  const finished = await reaches(() => h.stoppedLanes() === 2, 1000);
  expect({
    before,
    afterStop,
    finished,
    fetched: h.fetches.map((fetch) => fetch.queue),
    settled: h.settled.map((item) => [item.id.slice(-2), item.succeeded]),
    leftInQueue: (h.pending['c-b'] ?? []).length,
    heldAfter: permits.held(),
  }).toStrictEqual({
    before: { holding: true, fetched: ['c-a'], waiting: 1 },
    afterStop: { stoppedLanes: 1, fetched: 1, waiting: 0 },
    finished: true,
    fetched: ['c-a'],
    settled: [['01', true]],
    leftInQueue: 1,
    heldAfter: 0,
  });
}, 30_000);
