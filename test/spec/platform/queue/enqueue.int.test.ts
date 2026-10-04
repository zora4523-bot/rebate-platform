// Rule tests of enqueueing against a real PostgreSQL (ADR-0001 §2 队列与事件「任务与业务写入同一事务入队」,
// §4.2 第 14 项 `send(..., { db: fromKysely(trx) })`; 规划/02 §11「事务提交后才可被取走」「任务 ID =
// event_id」, §18 领域事件一行; contract sections 3 and 5 of
// apps/api/src/modules/platform/queue/index.ts). Every test gets its own clone of the migrated
// template (ADR-0001 §4.2 #9) and connects as couli_app. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { observe, settled, sleep, waitFor } from './kit.ts';
import {
  closeObserver,
  jobRows,
  observerOn,
  setupOn,
  stateOf,
  teardown,
  type Setup,
} from './int-kit.ts';

class Rollback extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** A handler that records each job it gets (its shape and frozenness) and resolves. */
function collecting(): { jobs: unknown[]; handler: (job: ReceivedJob) => Promise<void> } {
  const jobs: unknown[] = [];
  return {
    jobs,
    handler: async (job) => {
      jobs.push({
        keys: Reflect.ownKeys(job).map(String).sort(),
        frozen: Object.isFrozen(job),
        plain: Object.getPrototypeOf(job) === Object.prototype,
        id: job.id,
        queue: job.queue,
        name: job.name,
        payload: job.payload,
        attempt: job.attempt,
      });
    },
  };
}

async function eventRows(setup: Setup, eventId: string): Promise<string[]> {
  const rows = await setup.handles.db
    .selectFrom('processed_events')
    .select('consumer')
    .where('event_id', '=', eventId)
    .execute();
  return rows.map((row) => row.consumer);
}

const PAYLOAD = {
  order_id: '0190a6a0-0000-7000-8000-0000000000aa',
  amount_fen: 12_345,
  flags: [true, false, null],
  nested: { level: 2, text: '凑狸 \u{1F600}', list: [1, [2, [3]]] },
};

it('[ADR-0001 §2、§4.2 #14; 规划/02 §11、§18] 同事务入队：提交后业务行与任务都在、处理器收到确切的冻结任务对象一次；回滚后业务行与任务都不存在、处理器从未收到', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const collector = collecting();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { handlers: { 't-std': collector.handler } });
        const w = worker;
        await w.runtime.start();
        const kept = randomUUID();
        const dropped = randomUUID();
        const keptId = await w.handles.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('processed_events')
            .values({ consumer: 'tx', event_id: kept })
            .execute();
          return w.runtime.send('t-std', 'order.created', PAYLOAD, { trx });
        });
        let droppedId: string | null = 'not sent';
        const outcome = await w.handles.db
          .transaction()
          .execute(async (trx) => {
            await trx
              .insertInto('processed_events')
              .values({ consumer: 'tx', event_id: dropped })
              .execute();
            droppedId = await w.runtime.send('t-std', 'order.created', { id: dropped }, { trx });
            throw new Rollback();
          })
          .catch((error: unknown) => error);
        await waitFor(() => collector.jobs.length >= 1, 10_000);
        await sleep(1500);
        return {
          keptId: typeof keptId === 'string' && UUID.test(keptId),
          rolledBack: outcome instanceof Rollback,
          droppedIdWasReturned: typeof droppedId === 'string' && UUID.test(droppedId),
          keptState: await stateOf(observer, 't-std', keptId ?? ''),
          droppedRows: await jobRows(observer, droppedId ?? randomUUID()),
          keptBusiness: await eventRows(w, kept),
          droppedBusiness: await eventRows(w, dropped),
          jobs: collector.jobs,
          expectedJobs: [
            {
              keys: ['attempt', 'id', 'name', 'payload', 'queue'],
              frozen: true,
              plain: true,
              id: keptId,
              queue: 't-std',
              name: 'order.created',
              payload: PAYLOAD,
              attempt: 1,
            },
          ],
          lines: w.lines,
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toMatchObject({
    keptId: true,
    rolledBack: true,
    droppedIdWasReturned: true,
    keptState: 'completed',
    droppedRows: [],
    keptBusiness: ['tx'],
    droppedBusiness: [],
    lines: [],
  });
  const record = seen as { jobs?: unknown; expectedJobs?: unknown };
  expect(record.jobs).toStrictEqual(record.expectedJobs);
}, 60_000);

it('[规划/02 §11 事务提交后才可被取走] 事务未提交时 worker 看不到任务（期间等 2 秒、轮询 4 次以上），提交后才被处理', async () => {
  const seen = await withDatabase(async (database) => {
    let worker: Setup | undefined;
    const collector = collecting();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { handlers: { 't-std': collector.handler } });
        const w = worker;
        await w.runtime.start();
        let duringTransaction = -1;
        const id = await w.handles.db.transaction().execute(async (trx) => {
          const sent = await w.runtime.send('t-std', 'notify.push', { n: 1 }, { trx });
          await sleep(2000);
          duringTransaction = collector.jobs.length;
          return sent;
        });
        await waitFor(() => collector.jobs.length >= 1, 10_000);
        return {
          duringTransaction,
          afterCommit: collector.jobs.length,
          sameId: (collector.jobs[0] as { id?: unknown } | undefined)?.id === id,
        };
      });
    } finally {
      await teardown([worker]);
    }
  });
  expect(seen).toEqual({ duringTransaction: 0, afterCommit: 1, sameId: true });
}, 60_000);

it('[contract §3] trx 为 null 时单独入队并被处理；入队检查失败（未知队列、坏负载、坏选项）不碰事务，事务仍可继续写并提交', async () => {
  const seen = await withDatabase(async (database) => {
    let worker: Setup | undefined;
    const collector = collecting();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { handlers: { 't-std': collector.handler } });
        const w = worker;
        await w.runtime.start();
        const alone = await w.runtime.send('t-std', 'notify.push', { n: 2 }, { trx: null });
        const first = randomUUID();
        const second = randomUUID();
        const failures = await w.handles.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('processed_events')
            .values({ consumer: 'tx', event_id: first })
            .execute();
          const results = [
            await settled(w.runtime.send('nowhere', 'a', {}, { trx })),
            await settled(w.runtime.send('t-std', 'a', { n: 0.5 }, { trx })),
            await settled(w.runtime.send('t-std', 'a', {}, { trx, singletonKey: 'k' })),
          ];
          await trx
            .insertInto('processed_events')
            .values({ consumer: 'tx', event_id: second })
            .execute();
          return results;
        });
        await waitFor(() => collector.jobs.length >= 1, 10_000);
        await sleep(1000);
        return {
          failures,
          business: [...(await eventRows(w, first)), ...(await eventRows(w, second))],
          handled: collector.jobs.map((job) => (job as { id: unknown }).id),
          alone,
        };
      });
    } finally {
      await teardown([worker]);
    }
  });
  const record = seen as { alone?: unknown };
  expect(seen).toEqual({
    failures: [
      'QueueError unknown_queue',
      'QueueError invalid_payload',
      'QueueError invalid_option',
    ],
    business: ['tx', 'tx'],
    handled: [record.alone],
    alone: expect.stringMatching(UUID),
  });
}, 60_000);

it('[规划/02 §11 任务 ID = event_id] 指定 id：处理器收到的 job.id 就是它；同一队列再送同 id 返回 null 且不新增行；别的队列可用同 id；回滚的同 id 不占位；不指定时生成的 id 与处理器收到的一致', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    let sender: Setup | undefined;
    const collector = collecting();
    try {
      return await observe(async () => {
        sender = setupOn(database, 'api');
        const s = sender;
        await s.runtime.start();
        const eventId = randomUUID();
        const again = randomUUID();
        const results = {
          first: await s.runtime.send(
            't-std',
            'order.created',
            { e: 1 },
            { trx: null, id: eventId },
          ),
          duplicate: await s.runtime.send(
            't-std',
            'order.created',
            { e: 2 },
            { trx: null, id: eventId },
          ),
          otherQueue: await s.runtime.send(
            't-wide',
            'order.created',
            { e: 3 },
            { trx: null, id: eventId },
          ),
          rolledBack: await s.handles.db
            .transaction()
            .execute(async (trx) => {
              await s.runtime.send('t-std', 'order.created', { e: 4 }, { trx, id: again });
              throw new Rollback();
            })
            .catch((error: unknown) => (error instanceof Rollback ? 'rolled back' : error)),
          afterRollback: await s.runtime.send(
            't-std',
            'order.created',
            { e: 5 },
            { trx: null, id: again },
          ),
          generated: await s.runtime.send('t-std', 'order.created', { e: 6 }, { trx: null }),
        };
        const rows = (await jobRows(observer, eventId)).map((row) => row.queue);
        worker = setupOn(database, 'worker', { handlers: { 't-std': collector.handler } });
        await worker.runtime.start();
        await waitFor(() => collector.jobs.length >= 3, 15_000);
        await sleep(1000);
        const handled = collector.jobs
          .map((job) => {
            const { id, payload } = job as { id: string; payload: { e: number } };
            return [
              payload.e,
              id === eventId
                ? 'eventId'
                : id === again
                  ? 'again'
                  : id === results.generated
                    ? 'generated'
                    : 'other',
            ];
          })
          .sort();
        return {
          ...results,
          first: results.first === eventId,
          otherQueue: results.otherQueue === eventId,
          afterRollback: results.afterRollback === again,
          generated: typeof results.generated === 'string' && UUID.test(results.generated),
          rows,
          handled,
          senderLines: s.lines,
        };
      });
    } finally {
      await teardown([worker, sender]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    first: true,
    duplicate: null,
    otherQueue: true,
    rolledBack: 'rolled back',
    afterRollback: true,
    generated: true,
    rows: ['t-std', 't-wide'],
    handled: [
      [1, 'eventId'],
      [5, 'again'],
      [6, 'generated'],
    ],
    senderLines: [],
  });
}, 60_000);

it('[contract §3 delaySeconds] 延迟任务按 PostgreSQL 时间推后：delaySeconds 3600 的任务 3 秒内不交给处理器、start_after 在一小时后，delaySeconds 0 的任务立即处理', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const collector = collecting();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { handlers: { 't-std': collector.handler } });
        const w = worker;
        await w.runtime.start();
        const later = await w.runtime.send(
          't-std',
          'a',
          { k: 'later' },
          { trx: null, delaySeconds: 3600 },
        );
        const now = await w.runtime.send(
          't-std',
          'a',
          { k: 'now' },
          { trx: null, delaySeconds: 0 },
        );
        await waitFor(() => collector.jobs.length >= 1, 10_000);
        await sleep(3000);
        const deferred = await sql<{ deferred: boolean }>`
          SELECT start_after > now() + interval '3590 seconds'
             AND start_after < now() + interval '3610 seconds' AS deferred
          FROM pgboss.job WHERE id = ${later ?? randomUUID()}::uuid
        `.execute(observer);
        return {
          handled: collector.jobs.map((job) => (job as { payload: unknown }).payload),
          laterState: await stateOf(observer, 't-std', later ?? ''),
          nowState: await stateOf(observer, 't-std', now ?? ''),
          deferred: deferred.rows.map((row) => row.deferred),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    handled: [{ k: 'now' }],
    laterState: 'created',
    nowState: 'completed',
    deferred: [true],
  });
}, 60_000);
