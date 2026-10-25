// B1-01zzk against a real PostgreSQL (contract section 12 of
// apps/api/src/modules/platform/queue/index.ts): the worker runtime caps the handler calls running
// at once over all its queues at the shared budget (default 7, or limits.dbBudget) and each queue
// at its effective concurrency (limits.concurrency, only lower than the plan). Jobs beyond the cap
// stay queued — not claimed (pgboss.job state 'active' never exceeds the cap), not failed — and all
// complete on their first attempt with retry_count 0. The payout and api entries are unaffected.
// Handlers hold on a gate (no sleep races); every queue expires after 60 s, so nothing expires.
// Top-level it() only (规划/11 §4.3).
import type { DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  createQueueRuntime,
  type JobHandler,
  type QueueLimits,
  type QueueRuntime,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { gate, memoryLogger, observe, sleep, waitFor, type Entry } from '../queue/kit.ts';
import {
  closeObserver,
  handlesOn,
  observerOn,
  recorder,
  teardown,
  type Setup,
} from '../queue/int-kit.ts';
import { LIMIT_CATALOG, LIMIT_PLAN } from './kit.ts';

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** A runtime of `entry` on the test catalog and plan, with `limits` when given. */
function setupWith(
  database: TestDatabase,
  entry: Entry,
  limits: QueueLimits | undefined,
  handlers: Record<string, JobHandler> = {},
): Setup {
  const handles = handlesOn(database, entry);
  const { logger, lines } = memoryLogger(entry);
  const options = {
    entry,
    db: handles.db,
    logger,
    catalog: LIMIT_CATALOG,
    plan: LIMIT_PLAN,
    ...(limits === undefined ? {} : { limits }),
  };
  let runtime: QueueRuntime;
  try {
    runtime = createQueueRuntime(options as never);
  } catch (error) {
    void handles.close();
    throw error;
  }
  for (const [queue, handler] of Object.entries(handlers)) runtime.register(queue, handler);
  return { entry, handles, runtime, lines, logger };
}

/** Jobs of `queues` in pgboss.job: [queue, state, retry_count, count], ordered. */
async function jobStates(
  observer: Kysely<DB>,
  queues: readonly string[],
): Promise<Array<[string, string, number, number]>> {
  const result = await sql<{ name: string; state: string; retry_count: number; n: bigint }>`
    SELECT name, state::text AS state, retry_count, count(*) AS n FROM pgboss.job
    WHERE name = ANY(${[...queues]}::text[])
    GROUP BY name, state, retry_count ORDER BY name, state, retry_count
  `.execute(observer);
  return result.rows.map((row): [string, string, number, number] => [
    row.name,
    row.state,
    row.retry_count,
    Number(row.n),
  ]);
}

/** Claimed (state 'active') jobs of each of `queues`. */
async function claimed(
  observer: Kysely<DB>,
  queues: readonly string[],
): Promise<Record<string, number>> {
  const result = await sql<{ name: string; n: bigint }>`
    SELECT name, count(*) AS n FROM pgboss.job
    WHERE name = ANY(${[...queues]}::text[]) AND state = 'active' GROUP BY name
  `.execute(observer);
  const counts: Record<string, number> = Object.fromEntries(queues.map((queue) => [queue, 0]));
  for (const row of result.rows) counts[row.name] = Number(row.n);
  return counts;
}

async function completedCount(observer: Kysely<DB>, queues: readonly string[]): Promise<number> {
  const result = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM pgboss.job
    WHERE name = ANY(${[...queues]}::text[]) AND state = 'completed'
  `.execute(observer);
  return Number(result.rows[0]?.n ?? -1n);
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * The worker with `limits` works c-a, c-b and c-c (plan 4 + 4 + 2 = 10 slots), `perQueue` jobs
 * each, every handler holding on one gate: how many run at once, how many are claimed, and how the
 * jobs end once the gate opens.
 */
async function budgetScenario(limits: QueueLimits | undefined, perQueue: number, cap: number) {
  const queues = ['c-a', 'c-b', 'c-c'];
  return withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const release = gate();
    const rec = recorder();
    const attempts = new Set<number>();
    const track = (job: ReceivedJob) => {
      attempts.add(job.attempt);
      return rec.track(job.id, job.queue, job.name, job.attempt, () => release.wait());
    };
    try {
      return await observe(async () => {
        worker = setupWith(database, 'worker', limits, {
          'c-a': track,
          'c-b': track,
          'c-c': track,
        });
        const w = worker;
        await w.runtime.start();
        for (const queue of queues) {
          for (let n = 0; n < perQueue; n += 1) {
            await w.runtime.send(queue, 'budget.demo', { n }, { trx: null });
          }
        }
        const reached = await waitFor(() => rec.active() === cap, 15_000);
        // Four polling intervals: idle lanes would have claimed by now.
        await sleep(2000);
        const peak = rec.peak();
        const claimedWhileHeld = total(await claimed(observer, queues));
        release.open();
        const all = await waitFor(
          async () =>
            rec.calls.length === perQueue * queues.length &&
            rec.active() === 0 &&
            (await completedCount(observer, queues)) === perQueue * queues.length,
          45_000,
        );
        return {
          reached,
          peak,
          claimedWhileHeld,
          all,
          finalPeak: rec.peak(),
          attempts: [...attempts],
          states: await jobStates(observer, queues),
        };
      });
    } finally {
      release.open();
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
}

it('[B1-01zzk 全局预算] 缺省预算 7：worker 三个队列计划合计 10 个槽、36 个任务同时到达时，同时在跑的处理器与被领取的任务都正好 7，其余留在队列里排队；放行后 36 个全部完成，attempt 都是 1、retry_count 都是 0', async () => {
  const seen = await budgetScenario(undefined, 12, 7);
  expect(seen).toStrictEqual({
    reached: true,
    peak: 7,
    claimedWhileHeld: 7,
    all: true,
    finalPeak: 7,
    attempts: [1],
    states: [
      ['c-a', 'completed', 0, 12],
      ['c-b', 'completed', 0, 12],
      ['c-c', 'completed', 0, 12],
    ],
  });
}, 120_000);

it('[B1-01zzk 全局预算] limits.dbBudget 3：18 个任务同时到达时同时在跑与被领取的都正好 3；超出的排队、最终全部完成，不增加重试计数', async () => {
  const seen = await budgetScenario({ concurrency: {}, dbBudget: 3 }, 6, 3);
  expect(seen).toStrictEqual({
    reached: true,
    peak: 3,
    claimedWhileHeld: 3,
    all: true,
    finalPeak: 3,
    attempts: [1],
    states: [
      ['c-a', 'completed', 0, 6],
      ['c-b', 'completed', 0, 6],
      ['c-c', 'completed', 0, 6],
    ],
  });
}, 120_000);

it('[B1-01zzk 配置覆盖] limits.concurrency 把 c-a 调到 1：c-a 同时在跑与被领取的都不超过 1，未覆盖的 c-b 仍取计划值 4；放行后全部完成，attempt 都是 1、retry_count 都是 0', async () => {
  const queues = ['c-a', 'c-b'];
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const release = gate();
    const recA = recorder();
    const recB = recorder();
    const attempts = new Set<number>();
    try {
      return await observe(async () => {
        worker = setupWith(
          database,
          'worker',
          { concurrency: { 'c-a': 1 }, dbBudget: null },
          {
            'c-a': (job: ReceivedJob) => {
              attempts.add(job.attempt);
              return recA.track(job.id, job.queue, job.name, job.attempt, () => release.wait());
            },
            'c-b': (job: ReceivedJob) => {
              attempts.add(job.attempt);
              return recB.track(job.id, job.queue, job.name, job.attempt, () => release.wait());
            },
          },
        );
        const w = worker;
        await w.runtime.start();
        for (const queue of queues) {
          for (let n = 0; n < 6; n += 1) {
            await w.runtime.send(queue, 'override.demo', { n }, { trx: null });
          }
        }
        const reached = await waitFor(() => recA.active() === 1 && recB.active() === 4, 15_000);
        await sleep(2000);
        const peaks = { 'c-a': recA.peak(), 'c-b': recB.peak() };
        const claimedWhileHeld = await claimed(observer, queues);
        release.open();
        const all = await waitFor(
          async () =>
            recA.calls.length + recB.calls.length === 12 &&
            recA.active() + recB.active() === 0 &&
            (await completedCount(observer, queues)) === 12,
          45_000,
        );
        return {
          reached,
          peaks,
          claimedWhileHeld,
          all,
          attempts: [...attempts],
          states: await jobStates(observer, queues),
        };
      });
    } finally {
      release.open();
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toStrictEqual({
    reached: true,
    peaks: { 'c-a': 1, 'c-b': 4 },
    claimedWhileHeld: { 'c-a': 1, 'c-b': 4 },
    all: true,
    attempts: [1],
    states: [
      ['c-a', 'completed', 0, 6],
      ['c-b', 'completed', 0, 6],
    ],
  });
}, 120_000);

it('[B1-01zzk 其他入口不受影响] payout 与 api 入口拿到同样的 limits（预算 1）也照旧：api 照常发送，payout 的 c-pay 按计划并发 3 同时在跑，没有共享预算；放行后全部完成', async () => {
  const limits: QueueLimits = { concurrency: { 'c-a': 1 }, dbBudget: 1 };
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    let payout: Setup | undefined;
    const release = gate();
    const rec = recorder();
    try {
      return await observe(async () => {
        api = setupWith(database, 'api', limits);
        await api.runtime.start();
        payout = setupWith(database, 'payout', limits, {
          'c-pay': (job: ReceivedJob) =>
            rec.track(job.id, job.queue, job.name, job.attempt, () => release.wait()),
        });
        await payout.runtime.start();
        const ids: Array<string | null> = [];
        for (let n = 0; n < 5; n += 1) {
          ids.push(await api.runtime.send('c-pay', 'payout.demo', { n }, { trx: null }));
        }
        const reached = await waitFor(() => rec.active() === 3, 15_000);
        await sleep(2000);
        const peak = rec.peak();
        const claimedWhileHeld = await claimed(observer, ['c-pay']);
        release.open();
        const all = await waitFor(
          async () =>
            rec.calls.length === 5 &&
            rec.active() === 0 &&
            (await completedCount(observer, ['c-pay'])) === 5,
          45_000,
        );
        return {
          sent: ids.filter((id) => typeof id === 'string').length,
          reached,
          peak,
          claimedWhileHeld,
          all,
          states: await jobStates(observer, ['c-pay']),
        };
      });
    } finally {
      release.open();
      await teardown([payout, api]);
      await closeObserver(observer);
    }
  });
  expect(seen).toStrictEqual({
    sent: 5,
    reached: true,
    peak: 3,
    claimedWhileHeld: { 'c-pay': 3 },
    all: true,
    states: [['c-pay', 'completed', 0, 5]],
  });
}, 120_000);
