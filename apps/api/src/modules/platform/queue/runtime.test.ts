import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootLogger } from '../logging/logger.ts';
import { createQueueRuntime } from './runtime.ts';
import type { JobPayload, QueueRuntime, QueueSpec } from './types.ts';

// No database runs: fetch is observed independently from business handler calls.
// Each statement records its text and the executor it ran on (B1-01zs: the version read).
const statements = vi.hoisted(() => [] as { text: string; executor: unknown }[]);
// A statement text that rejects with `error` (B1-01zs: a lock timeout during start).
const failing = vi.hoisted(() => ({ text: '', error: undefined as unknown }));
vi.mock('kysely', async (original) => ({
  ...(await original<typeof import('kysely')>()),
  sql: (strings: TemplateStringsArray) => ({
    execute: async (executor: unknown) => {
      const text = strings.join('$');
      statements.push({ text, executor });
      if (failing.error !== undefined && text === failing.text) throw failing.error;
      return {
        rows: [{ version: 42, id: 'claimed', startedOnExact: '2026-10-04 00:00:00.123456+00' }],
      };
    },
  }),
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
  // pg-boss's fromKysely, reached only through the module mock below (no import of pg-boss here).
  fromKysely: vi.fn<(db: unknown) => unknown>(() => ({})),
  fetch: vi.fn<(queue: string) => Promise<FetchedJob[]>>(),
  complete: vi.fn(async (): Promise<void> => undefined),
  fail: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  getQueues: vi.fn(async (): Promise<unknown[]> => []),
  bossStart: vi.fn(async (): Promise<void> => undefined),
  options: undefined as
    | { db: { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> } }
    | undefined,
}));
vi.mock('pg-boss', () => ({
  fromKysely: fake.fromKysely,
  PgBoss: class {
    constructor(options: typeof fake.options) {
      fake.options = options;
    }
    on() {}
    getQueues = fake.getQueues;
    start = fake.bossStart;
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
  failing.error = undefined;
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
    db: {
      executeQuery: vi.fn(),
      transaction: () => ({ execute: async (run: (trx: unknown) => Promise<unknown>) => run({}) }),
    } as unknown as Kysely<DB>,
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
    expect(logger.warn.mock.calls).toEqual(
      Array.from({ length: limit }, (_, i) => [
        { queue: 'payout', jobId: `first-${i}`, attempt: 1 },
        'job_handler_overrun',
      ]),
    );
    release.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.filter((id) => id === 'next')).toEqual(['next']);
    expect(peak).toBe(limit);
    expect(active).toBe(0);
    expect(fake.complete).toHaveBeenCalledWith('payout', 'next', undefined, { db: {} });
    expect(fake.complete).not.toHaveBeenCalledWith('payout', 'first-0', undefined, { db: {} });
    expect(fake.fail).not.toHaveBeenCalledWith(
      'payout',
      'next',
      expect.anything(),
      expect.anything(),
    );
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
  expect(fake.fail).toHaveBeenCalledWith(
    'payout',
    'expired',
    { error: 'handler_failed' },
    { db: {} },
  );
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
  expect(fake.fail).toHaveBeenCalledWith('payout', 'late', { error: 'handler_failed' }, { db: {} });
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
    expect(logger.warn.mock.calls).toEqual([
      ...(elapsed === 1000
        ? [[{ queue: 'payout', jobId: 'first', attempt: 1 }, 'job_handler_overrun']]
        : []),
      [{ running: 1 }, 'queue_stop_timeout'],
    ]);
    expect(fake.fail).toHaveBeenCalledExactlyOnceWith(
      'payout',
      'first',
      { error: 'handler_failed' },
      { db: {} },
    );
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
  expect(fake.complete).toHaveBeenCalledWith('payout', 'first', undefined, { db: {} });
  expect(fake.stop).not.toHaveBeenCalled();
  saved.resolve();
  await stopping;
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(fake.fail).not.toHaveBeenCalled();
  expect(pending.get('payout')).toEqual([job('waiting')]);
  expect(logger.warn).not.toHaveBeenCalled();
});

type FakeTransaction = { execute: (run: (trx: unknown) => Promise<unknown>) => Promise<unknown> };

function boundedFixture(transaction: () => FakeTransaction) {
  vi.useFakeTimers();
  fake.fetch.mockReset();
  fake.fetch.mockResolvedValue([]);
  fake.stop.mockClear();
  statements.length = 0;
  failing.text = '';
  failing.error = undefined;
  const plain = { executeSql: vi.fn(async () => ({ rows: [{ plain: true }] })) };
  fake.fromKysely.mockReturnValueOnce(plain);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const spec: QueueSpec = {
    name: 'payout',
    policy: 'exclusive',
    retryLimit: 0,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 1,
    retentionSeconds: 60,
    deleteAfterSeconds: 60,
    deadLetter: null,
  };
  const runtime = createQueueRuntime({
    entry: 'payout',
    db: { executeQuery: vi.fn(), transaction } as unknown as Kysely<DB>,
    logger: logger as unknown as RootLogger,
    catalog: [spec],
    plan: {
      api: [],
      stream: [],
      admin: [],
      worker: [],
      payout: [{ queue: 'payout', concurrency: 1, pollingIntervalSeconds: 0.5 }],
    },
    stopTimeoutMs: 100,
  });
  runtimes.push(runtime);
  return { runtime, logger, plain };
}

/** Transaction-local limits (is_local = true): nothing to reset on the pooled connection. */
const LIMIT =
  /^SELECT set_config\('lock_timeout', \$, true\),\s+set_config\('statement_timeout', \$, true\)$/;
const OWN = '\n    BEGIN;\n    SET LOCAL lock_timeout = 30000;\n    SELECT 1;\n    COMMIT;\n  ';

it('[AC-B1-01zs#3] 版本读取与 boss.start() 返回前 pg-boss 的单条语句各在自己的事务里先设事务内上限；pg-boss 自带事务的文本、boss.start() 之后的语句走共享池，不设上限也无需复原', async () => {
  const trxs: { executeQuery: ReturnType<typeof vi.fn> }[] = [];
  const transaction = vi.fn(() => ({
    execute: async (run: (inner: unknown) => Promise<unknown>) => {
      const trx = { executeQuery: vi.fn(async () => ({ rows: [{ queue: 'row' }] })) };
      trxs.push(trx);
      return run(trx);
    },
  }));
  const { runtime, plain } = boundedFixture(transaction);
  const seen: unknown[] = [];
  fake.getQueues.mockImplementationOnce(async () => {
    seen.push(await fake.options?.db.executeSql('SELECT name FROM pgboss.queue', ['a']));
    seen.push(await fake.options?.db.executeSql(OWN));
    return [];
  });
  fake.bossStart.mockImplementationOnce(async () => {
    seen.push(await fake.options?.db.executeSql('SELECT version FROM pgboss.version', []));
  });
  // No handler is registered: a consumer lane would open its fetch transaction right after
  // boss.start() returned, racing the counts below. Every transaction counted here is start()'s.
  await runtime.start();
  expect(seen).toEqual([
    { rows: [{ queue: 'row' }] },
    { rows: [{ plain: true }] },
    { rows: [{ queue: 'row' }] },
  ]);
  // Runtime read, pg-boss queue read, pg-boss's own version read inside boss.start().
  expect(transaction).toHaveBeenCalledTimes(3);
  expect(
    statements.map((statement) => [statement.text, trxs.indexOf(statement.executor as never)]),
  ).toEqual([
    [expect.stringMatching(LIMIT), 0],
    ['SELECT version FROM pgboss.version', 0],
    [expect.stringMatching(LIMIT), 1],
    [expect.stringMatching(LIMIT), 2],
  ]);
  expect(trxs[1]?.executeQuery.mock.calls).toMatchObject([
    [{ sql: 'SELECT name FROM pgboss.queue', parameters: ['a'] }],
  ]);
  expect(trxs[2]?.executeQuery.mock.calls).toMatchObject([
    [{ sql: 'SELECT version FROM pgboss.version', parameters: [] }],
  ]);
  expect(plain.executeSql.mock.calls).toEqual([[OWN, undefined]]);
  expect(await fake.options?.db.executeSql('SELECT 1', [])).toEqual({ rows: [{ plain: true }] });
  expect(plain.executeSql).toHaveBeenLastCalledWith('SELECT 1', []);
  expect(transaction).toHaveBeenCalledTimes(3);
});

it('[AC-B1-01zs#3] 版本读取等锁超时：start 立即以同一错误拒绝，不等回滚；stop 等回滚结束才继续；不领任务、不写日志', async () => {
  const rollback = Promise.withResolvers<void>();
  let rolledBack = false;
  const { runtime, logger } = boundedFixture(() => ({
    execute: async (run: (inner: unknown) => Promise<unknown>) => {
      try {
        return await run({});
      } catch (error) {
        await rollback.promise;
        rolledBack = true;
        throw error;
      }
    },
  }));
  const timeout = Object.assign(new Error('canceling statement due to lock timeout'), {
    code: '55P03',
  });
  failing.text = 'SELECT version FROM pgboss.version';
  failing.error = timeout;
  runtime.register('payout', async () => undefined);
  await expect(runtime.start()).rejects.toBe(timeout);
  expect(rolledBack).toBe(false);
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(stopped).toBe(false);
  // Only start()'s own failure cleanup has stopped pg-boss so far.
  expect(fake.stop).toHaveBeenCalledTimes(1);
  rollback.resolve();
  await stopping;
  expect(rolledBack).toBe(true);
  expect(fake.stop).toHaveBeenCalledTimes(2);
  expect(statements.map((statement) => statement.text)).toEqual([
    expect.stringMatching(LIMIT),
    'SELECT version FROM pgboss.version',
  ]);
  expect(fake.fetch).not.toHaveBeenCalled();
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});
