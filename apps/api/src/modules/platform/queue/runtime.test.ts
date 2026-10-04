import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootLogger } from '../logging/logger.ts';
import { createQueueRuntime } from './runtime.ts';
import type { JobPayload, QueueRuntime, QueueSpec } from './types.ts';

// No database runs: fetch is observed independently from business handler calls.
vi.mock('kysely', async (original) => ({
  ...(await original<typeof import('kysely')>()),
  sql: () => ({ execute: async () => ({ rows: [{ version: 42 }] }) }),
}));

interface FetchedJob {
  id: string;
  data: { name: string; payload: JobPayload };
  retryCount: number;
  retryLimit: number;
  expireInSeconds: number;
  signal?: AbortSignal;
}
const fake = vi.hoisted(() => ({
  fetch: vi.fn<(queue: string) => Promise<FetchedJob[]>>(),
  complete: vi.fn(async (): Promise<void> => undefined),
  fail: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
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
    fetch = fake.fetch;
    complete = fake.complete;
    fail = fake.fail;
    stop = fake.stop;
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

function job(id: string, extra: Partial<FetchedJob> = {}): FetchedJob {
  return {
    id,
    data: { name: 'payout.query', payload: { secret: 'never-log-this' } },
    retryCount: 0,
    retryLimit: 0,
    expireInSeconds: 1,
    ...extra,
  };
}

function fixture(concurrency = 1) {
  vi.useFakeTimers();
  fake.fetch.mockReset();
  fake.complete.mockClear();
  fake.fail.mockClear();
  fake.stop.mockClear();
  const pending = new Map<string, FetchedJob[]>([
    ['payout', []],
    ['notify', []],
  ]);
  fake.fetch.mockImplementation(async (queue) => pending.get(queue)!.splice(0, 1));
  const catalog: QueueSpec[] = ['payout', 'notify'].map((name) => ({
    name,
    policy: name === 'payout' ? 'exclusive' : 'standard',
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 1,
    retentionSeconds: 60,
    deleteAfterSeconds: 60,
    deadLetter: null,
  }));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const runtime = createQueueRuntime({
    entry: 'payout',
    db: { executeQuery: vi.fn() } as unknown as Kysely<DB>,
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
  return { runtime, logger, pending };
}

it.each([1, 2])(
  '[AC-B1-01g#3] 并发 %i：处理器超时仍占名额，零重试后续任务不被领取且最终执行一次',
  async (limit) => {
    const { runtime, pending, logger } = fixture(limit);
    const release = Promise.withResolvers<void>();
    const seen: string[] = [];
    let active = 0;
    let peak = 0;
    runtime.register('payout', async (received) => {
      seen.push(received.id);
      active++;
      peak = Math.max(peak, active);
      if (received.id.startsWith('first')) await release.promise;
      active--;
    });
    runtime.register('notify', async () => {
      seen.push('independent');
    });
    pending
      .get('payout')!
      .push(...Array.from({ length: limit }, (_, i) => job(`first-${i}`)), job('next'));
    pending.get('notify')!.push(job('other'));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(2250);
    expect(fake.fetch.mock.calls.filter(([queue]) => queue === 'payout')).toHaveLength(limit);
    expect(pending.get('payout')).toEqual([job('next')]);
    expect(seen).toContain('independent');
    expect(seen).not.toContain('next');
    expect(fake.fail).toHaveBeenCalledTimes(limit);
    expect(logger.warn).not.toHaveBeenCalled();
    release.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.filter((id) => id === 'next')).toEqual(['next']);
    expect(peak).toBe(limit);
    expect(active).toBe(0);
    expect(fake.complete).toHaveBeenCalledWith('payout', 'next');
    expect(fake.complete).not.toHaveBeenCalledWith('payout', 'first-0');
    expect(fake.fail).not.toHaveBeenCalledWith('payout', 'next', expect.anything());
  },
);

it('[AC-B1-01g#4] 兜底释放已过期任务，日志只含队列、任务编号与次数', async () => {
  const { runtime, pending, logger } = fixture();
  const lease = new AbortController();
  lease.abort();
  pending.get('payout')!.push(job('expired', { signal: lease.signal }));
  const handler = vi.fn(async () => undefined);
  runtime.register('payout', handler);
  await runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(handler).not.toHaveBeenCalled();
  expect(fake.fail).toHaveBeenCalledWith('payout', 'expired', { error: 'handler_failed' });
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: 'expired', attempt: 1 }, 'job_released_on_expiry'],
  ]);
});

it('[AC-B1-01g#6] 停机等待在途领取，迟到的最后一次任务释放后才关闭队列', async () => {
  const { runtime, logger } = fixture();
  const fetched = Promise.withResolvers<FetchedJob[]>();
  fake.fetch.mockImplementation(() => fetched.promise);
  const handler = vi.fn(async () => undefined);
  runtime.register('payout', handler);
  await runtime.start();
  const stopping = runtime.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(fake.stop).not.toHaveBeenCalled();
  fetched.resolve([job('late', { retryCount: 2, retryLimit: 2 })]);
  await stopping;
  expect(handler).not.toHaveBeenCalled();
  expect(fake.fail).toHaveBeenCalledWith('payout', 'late', { error: 'handler_failed' });
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: 'late', attempt: 3 }, 'job_released_on_stop'],
  ]);
  expect(logger.error).not.toHaveBeenCalled();
  expect(fake.stop).toHaveBeenCalledOnce();
});

it.each([0, 1000])(
  '[AC-B1-01g#7] 停机时已运行 %i ms：等待真实处理器至期限，释放后迟到结果不再改任务',
  async (elapsed) => {
    const { runtime, logger, pending } = fixture();
    const release = Promise.withResolvers<void>();
    const handler = vi.fn(async () => release.promise);
    runtime.register('payout', handler);
    pending.get('payout')!.push(job('first'), job('waiting'));
    await runtime.start();
    await vi.advanceTimersByTimeAsync(elapsed);
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(pending.get('payout')).toEqual([job('waiting')]);
    expect(logger.warn.mock.calls).toEqual([[{ running: 1 }, 'queue_stop_timeout']]);
    expect(fake.fail).toHaveBeenCalledExactlyOnceWith('payout', 'first', {
      error: 'handler_failed',
    });
    release.reject(new Error('secret failure after stop'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.complete).not.toHaveBeenCalled();
    expect(fake.fail).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-01g#8] 优雅关闭等处理器及完成写入；未领取任务不消耗重试', async () => {
  const { runtime, pending, logger } = fixture();
  const release = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<void>();
  runtime.register('payout', async () => release.promise);
  pending.get('payout')!.push(job('first'), job('waiting'));
  fake.complete.mockImplementationOnce(async () => saved.promise);
  await runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = runtime.stop();
  release.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.complete).toHaveBeenCalledWith('payout', 'first');
  expect(fake.stop).not.toHaveBeenCalled();
  saved.resolve();
  await stopping;
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(fake.fail).not.toHaveBeenCalled();
  expect(pending.get('payout')).toEqual([job('waiting')]);
  expect(logger.warn).not.toHaveBeenCalled();
});
