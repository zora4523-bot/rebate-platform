import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootLogger } from '../logging/logger.ts';
import { createQueueRuntime } from './runtime.ts';
import type { JobHandler, JobPayload, QueueRuntime, QueueSpec } from './types.ts';

// No database or queue-library worker runs: the callbacks receive in-memory leases.
vi.mock('kysely', async (original) => ({
  ...(await original<typeof import('kysely')>()),
  sql: () => ({ execute: async () => ({ rows: [{ version: 42 }] }) }),
}));

interface BatchJob {
  id: string;
  data: { name: string; payload: JobPayload };
  retryCount: number;
  retryLimit: number;
  signal: AbortSignal;
}
type BatchHandler = (jobs: BatchJob[]) => Promise<void>;
const fake = vi.hoisted(() => ({
  callbacks: new Map<string, BatchHandler>(),
  offWork: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock('pg-boss', () => ({
  fromKysely: () => ({}),
  PgBoss: class {
    on() {}
    async getQueues() {
      return [];
    }
    async start() {}
    async createQueue() {}
    async findJobs() {
      return [];
    }
    async stop() {}
    async work(name: string, _options: unknown, handler: BatchHandler) {
      fake.callbacks.set(name, handler);
      return name;
    }
    offWork = fake.offWork;
  },
}));
const runtimes: QueueRuntime[] = [];

afterEach(async () => {
  const stopping = Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await vi.advanceTimersByTimeAsync(100);
  await stopping;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(concurrency = 1) {
  fake.callbacks.clear();
  fake.offWork.mockReset().mockResolvedValue(undefined);
  vi.useFakeTimers();
  const catalog: QueueSpec[] = ['payout', 'notify'].map((name) => ({
    name,
    policy: name === 'payout' ? 'exclusive' : 'standard',
    retryLimit: 2,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 1,
    retentionSeconds: 60,
    deleteAfterSeconds: 60,
    deadLetter: null,
  }));
  const db = { executeQuery: vi.fn() } as unknown as Kysely<DB>;
  const logger = { warn: vi.fn(), error: vi.fn() };
  const runtime = createQueueRuntime({
    entry: 'payout',
    db,
    logger: logger as unknown as RootLogger,
    catalog,
    plan: {
      api: [],
      stream: [],
      admin: [],
      worker: [],
      payout: catalog.map((spec) => ({
        queue: spec.name,
        concurrency,
        pollingIntervalSeconds: 0.5,
      })),
    },
    stopTimeoutMs: 100,
  });
  runtimes.push(runtime);
  function deliver(queue: string, id: string, alreadyExpired = false, retryCount = 0) {
    const lease = new AbortController();
    if (alreadyExpired) lease.abort();
    const job = {
      id,
      data: { name: 'payout.query', payload: { secret: 'never-log-this' } },
      retryCount,
      retryLimit: 2,
      signal: lease.signal,
    } satisfies BatchJob;
    // Pg-boss expires a batch and releases its own slot while this promise may still run.
    const expired = setTimeout(() => lease.abort(), 1000);
    const result = fake.callbacks.get(queue)!([job])
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => clearTimeout(expired));
    return { result, lease };
  }
  return { runtime, logger, deliver, offWork: fake.offWork };
}

it.each([1, 2])(
  '[AC-B1-01g#3] 并发 %i：超时不释放业务名额，等待期间过期的任务不执行',
  async (limit) => {
    const { runtime, deliver } = fixture(limit);
    const releases = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const seen: string[] = [];
    let active = 0;
    let peak = 0;
    const handler: JobHandler = async (job) => {
      seen.push(job.id);
      active++;
      peak = Math.max(peak, active);
      const release = Promise.withResolvers<void>();
      releases.set(job.id, release);
      await release.promise;
      active--;
    };
    runtime.register('payout', handler);
    runtime.register('notify', async () => {
      seen.push('independent');
    });
    await runtime.start();
    const initial = Array.from({ length: limit }, (_, i) => deliver('payout', `first-${i}`));
    await vi.advanceTimersByTimeAsync(1000);
    const expired = deliver('payout', 'expires-waiting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await expired.result).toEqual({ error: 'handler_failed' });
    const waiting = deliver('payout', 'next');
    await deliver('notify', 'other-queue').result;
    expect(seen).toEqual([...Array.from({ length: limit }, (_, i) => `first-${i}`), 'independent']);
    releases.get('first-0')!.resolve();
    await initial[0]!.result;
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe('next');
    expect(peak).toBe(limit);
    for (const release of releases.values()) release.resolve();
    await Promise.all([...initial.map((item) => item.result), waiting.result]);
    expect(active).toBe(0);
  },
);

it('[AC-B1-01g#4] 收到已经过期的任务时不启动业务处理器', async () => {
  const { runtime, deliver } = fixture();
  const handler = vi.fn(async () => undefined);
  runtime.register('payout', handler);
  await runtime.start();
  expect(await deliver('payout', 'expired', true).result).toEqual({ error: 'handler_failed' });
  expect(handler).not.toHaveBeenCalled();
});

it('[AC-B1-01g#6] 停机后迟到的最后一次取任务回调记录释放日志，不执行处理器', async () => {
  const { runtime, logger, deliver, offWork } = fixture();
  const handler = vi.fn(async () => undefined);
  runtime.register('payout', handler);
  await runtime.start();
  const fetched = Promise.withResolvers<void>();
  offWork.mockImplementation(async () => fetched.promise);
  const stopping = runtime.stop();
  expect(await deliver('payout', 'late', false, 2).result).toEqual({ error: 'handler_failed' });
  fetched.resolve();
  await stopping;
  expect(handler).not.toHaveBeenCalled();
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: 'late', attempt: 3 }, 'job_released_on_stop'],
  ]);
  expect(logger.error).not.toHaveBeenCalled();
});

it('[AC-B1-01g#7] 停机唤醒等待名额的任务，并对已过期但未结束的处理器保留停机期限', async () => {
  const { runtime, logger, deliver } = fixture();
  const release = Promise.withResolvers<void>();
  const handler = vi.fn(async () => release.promise);
  runtime.register('payout', handler);
  await runtime.start();
  const first = deliver('payout', 'first');
  await vi.advanceTimersByTimeAsync(1000);
  const waiting = deliver('payout', 'waiting');
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  expect(await waiting.result).toEqual({ error: 'handler_failed' });
  await vi.advanceTimersByTimeAsync(99);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  expect(handler).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: 'waiting', attempt: 1 }, 'job_released_on_stop'],
    [{ running: 1 }, 'queue_stop_timeout'],
  ]);
  release.resolve();
  await first.result;
});
