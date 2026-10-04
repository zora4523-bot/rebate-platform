import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootLogger } from '../logging/logger.ts';
import { fetchAttempt, settleAttempt } from './attempt.ts';
import { runExecutor, type ExecutorOptions } from './executor.ts';

interface MemoryConnection {
  executeSql(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

afterEach(() => vi.useRealTimers());

// Real Kysely compilation/transactions and fromKysely, with an in-memory connection.
// Its settlement deliberately has pg-boss's broad id-only semantics. The row lock
// and ownership predicates must prevent an old caller from reaching that settlement.
function fixture() {
  const row = {
    name: 'payout',
    id: '00000000-0000-4000-8000-000000000001',
    state: 'created',
    retryCount: 0,
    startedOn: '2026-10-04 00:00:00.123456+00',
  };
  let nextConnection: Promise<void> | undefined;
  const writes: string[] = [];
  const queries: string[] = [];
  const pool = {
    options: {},
    end: async () => undefined,
    async connect() {
      const wait = nextConnection;
      nextConnection = undefined;
      await wait;
      let transaction = false;
      let locked = false;
      return {
        release() {},
        async query(text: string, parameters: readonly unknown[]) {
          const query = text.replace(/\s+/g, ' ').trim();
          queries.push(query);
          if (query === 'begin') transaction = true;
          else if (query === 'commit' || query === 'rollback') {
            transaction = false;
            locked = false;
          } else if (query === 'claim') {
            expect(transaction).toBe(true);
            if (row.state !== 'created' && row.state !== 'retry') return { rows: [] };
            if (row.state === 'retry') row.retryCount++;
            row.state = 'active';
            locked = true;
            return {
              rows: [
                {
                  id: row.id,
                  data: { name: 'payout.query', payload: { secret: 'never-log-this' } },
                  retryCount: row.retryCount,
                  retryLimit: 1,
                  expireInSeconds: 1,
                  startedOn: new Date(row.startedOn),
                },
              ],
            };
          } else if (query.startsWith('SELECT started_on::text')) {
            expect(transaction && locked).toBe(true);
            expect(parameters).toEqual([row.name, row.id]);
            return { rows: [{ startedOnExact: row.startedOn }] };
          } else if (query.startsWith('SELECT id FROM pgboss.job')) {
            expect(transaction).toBe(true);
            expect(query).toBe(
              "SELECT id FROM pgboss.job WHERE name = $1 AND id = $2::uuid AND state = 'active' AND retry_count = $3 AND started_on = $4::timestamptz FOR UPDATE",
            );
            const owned =
              row.state === 'active' &&
              parameters[0] === row.name &&
              parameters[1] === row.id &&
              parameters[2] === row.retryCount &&
              parameters[3] === row.startedOn;
            locked = owned;
            return { rows: owned ? [{ id: row.id }] : [] };
          } else if (query === 'complete' || query === 'fail') {
            expect(transaction && locked).toBe(true);
            writes.push(query);
            row.state = query === 'complete' ? 'completed' : 'failed';
          } else throw new Error(`unexpected query: ${query}`);
          return { rows: [] };
        },
      };
    },
  };
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: pool as PostgresPool }) });
  const boss = {
    fetch: vi.fn(
      async (_queue: string, options: { db: MemoryConnection }) =>
        (await options.db.executeSql('claim', [])).rows,
    ),
    complete: vi.fn(
      async (_queue: string, _id: string, _data: unknown, options: { db: MemoryConnection }) =>
        options.db.executeSql('complete', []),
    ),
    fail: vi.fn(
      async (_queue: string, _id: string, data: unknown, options: { db: MemoryConnection }) => {
        expect(data).toEqual({ error: 'handler_failed' });
        return options.db.executeSql('fail', []);
      },
    ),
  } as unknown as ExecutorOptions['boss'];
  const logger = { warn: vi.fn(), error: vi.fn() };
  return {
    row,
    db,
    boss,
    writes,
    queries,
    logger,
    pauseNextConnection() {
      const paused = Promise.withResolvers<void>();
      nextConnection = paused.promise;
      return paused.resolve;
    },
  };
}

it('[AC-B1-01g#10] W1 到期后等连接，W2 回收并领取重试，W1 迟到失败不能改 W2 状态', async () => {
  vi.useFakeTimers();
  const { db, boss, row, logger, pauseNextConnection, writes } = fixture();
  const shutdown = new AbortController();
  const deadline = new AbortController();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const runningHandlers = new Set<Promise<void>>();
  const runner = runExecutor({
    db,
    boss,
    logger: logger as unknown as RootLogger,
    work: { queue: 'payout', concurrency: 1, pollingIntervalSeconds: 0.5 },
    shutdown: shutdown.signal,
    deadline: deadline.signal,
    runningHandlers,
    handler: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  const resume = pauseNextConnection();
  await vi.advanceTimersByTimeAsync(999);
  expect(logger.warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: row.id, attempt: 1 }, 'job_handler_overrun'],
  ]);
  expect(runningHandlers.size).toBe(1);
  // The peer supervisor releases the expired attempt; W2 takes its only retry.
  row.state = 'retry';
  row.startedOn = '2026-10-04 00:00:02.654321+00';
  const [second] = await fetchAttempt(db, boss, 'payout');
  expect(second?.retryCount).toBe(1);
  resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(row.state).toBe('active');
  expect(writes).toEqual([]);
  expect(logger.warn.mock.calls).toEqual([
    [{ queue: 'payout', jobId: row.id, attempt: 1 }, 'job_handler_overrun'],
    [{ queue: 'payout', jobId: row.id, attempt: 1 }, 'job_attempt_superseded'],
  ]);
  expect(boss.fetch).toHaveBeenCalledTimes(2);
  expect(runningHandlers.size).toBe(1);
  expect(await settleAttempt(db, boss, 'payout', second!, true)).toBe(true);
  expect(row.state).toBe('completed');
  shutdown.abort();
  release.reject(new Error('private handler failure'));
  await runner;
  expect(writes).toEqual(['complete']);
  expect(logger.error).not.toHaveBeenCalled();
  await db.destroy();
});

it.each([true, false])(
  '[AC-B1-01g#11] 完成=%s：分别校验状态、次数、微秒时间，当前尝试在事务中正常落盘',
  async (succeeded) => {
    const { db, boss, row, writes, queries } = fixture();
    const [claimed] = await fetchAttempt(db, boss, 'payout');
    expect(claimed?.startedOnExact).toBe('2026-10-04 00:00:00.123456+00');
    row.state = 'retry';
    expect(await settleAttempt(db, boss, 'payout', claimed!, succeeded)).toBe(false);
    row.state = 'active';
    row.retryCount++;
    expect(await settleAttempt(db, boss, 'payout', claimed!, succeeded)).toBe(false);
    row.retryCount--;
    // Same JS millisecond, distinct PostgreSQL timestamp; cannot settle this other lease.
    row.startedOn = '2026-10-04 00:00:00.123457+00';
    expect(await settleAttempt(db, boss, 'payout', claimed!, succeeded)).toBe(false);
    expect(writes).toEqual([]);
    row.startedOn = claimed!.startedOnExact;
    expect(await settleAttempt(db, boss, 'payout', claimed!, succeeded)).toBe(true);
    expect(writes).toEqual([succeeded ? 'complete' : 'fail']);
    expect(queries.slice(-4)).toEqual([
      'begin',
      expect.stringContaining('FOR UPDATE'),
      succeeded ? 'complete' : 'fail',
      'commit',
    ]);
    await db.destroy();
  },
);
