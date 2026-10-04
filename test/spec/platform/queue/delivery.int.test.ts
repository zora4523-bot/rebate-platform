// Rule tests of at-least-once delivery against a real PostgreSQL (ADR-0001 §3「至少一次投递 → 消费端
// processed_events 去重」; 规划/02 §11 消费幂等, §7.1「失败窗口进死信队列」, §18 领域事件一行; contract
// sections 5 and 7 of apps/api/src/modules/platform/queue/index.ts). A handler that throws is
// retried per the queue settings and finally failed into the dead letter queue; the stored output
// and the log lines are exact and carry nothing of the error or the payload.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { line, observe, reduceLine, sleep, waitFor } from './kit.ts';
import {
  closeObserver,
  deadCopies,
  jobRows,
  observerOn,
  setupOn,
  teardown,
  type Setup,
} from './int-kit.ts';

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** Personal data a payload might carry by mistake, and an error message that repeats it. */
const PERSONAL = {
  phone: '13912345678',
  name: '张小凑',
  account: 'couli.user@example.com',
};
const OUTPUT = '{"error": "handler_failed"}';

class LeakyError extends Error {
  readonly detail = PERSONAL;

  constructor() {
    super(`cannot notify ${PERSONAL.name} at ${PERSONAL.phone} / ${PERSONAL.account}`);
    this.name = 'LeakyError';
  }
}

function allText(setup: Setup): string {
  return setup.lines.join('');
}

it('[ADR-0001 §3 至少一次; 规划/02 §7.1 死信] 处理器一直抛错：按队列设置共调用 retryLimit+1 次（attempt 1、2、3），最终 failed 并复制进死信队列；两处输出都正好是 {"error": "handler_failed"}；日志正好两条 job_failed 与一条 job_failed_final，不含负载与错误内容', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const attempts: number[] = [];
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-std': async (job: ReceivedJob) => {
              attempts.push(job.attempt);
              throw new LeakyError();
            },
          },
        });
        const w = worker;
        await w.runtime.start();
        const id =
          (await w.runtime.send('t-std', 'notify.push', { to: PERSONAL }, { trx: null })) ?? '';
        const finished = await waitFor(
          async () => (await deadCopies(observer, id)).length > 0,
          20_000,
        );
        await sleep(1500);
        return {
          finished,
          attempts,
          rows: await jobRows(observer, id),
          dead: await deadCopies(observer, id),
          lines: w.lines.map(reduceLine),
          expectedLines: [1, 2, 3].map((attempt) =>
            line(
              'worker',
              attempt === 3 ? 'error' : 'warn',
              { queue: 't-std', jobName: 'notify.push', jobId: id, attempt },
              attempt === 3 ? 'job_failed_final' : 'job_failed',
            ),
          ),
          personalInLogs: Object.values(PERSONAL).filter((value) => allText(w).includes(value)),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toMatchObject({
    finished: true,
    attempts: [1, 2, 3],
    rows: [{ queue: 't-std', state: 'failed', retryCount: 2, output: OUTPUT, singletonKey: null }],
    dead: [{ queue: 'test-dead', state: 'created', sourceName: 't-std', output: OUTPUT }],
    personalInLogs: [],
  });
  const record = seen as { lines?: unknown; expectedLines?: unknown };
  expect(record.lines).toStrictEqual(record.expectedLines);
}, 60_000);

it('[ADR-0001 §3 至少一次] 处理器第一次抛错、第二次成功：共调用两次（attempt 1、2），任务 completed，没有死信副本，日志正好一条 job_failed', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const attempts: number[] = [];
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-std': async (job: ReceivedJob) => {
              attempts.push(job.attempt);
              if (job.attempt === 1) throw new LeakyError();
            },
          },
        });
        const w = worker;
        await w.runtime.start();
        const id = (await w.runtime.send('t-std', 'order.updated', { n: 1 }, { trx: null })) ?? '';
        const done = await waitFor(
          async () => (await jobRows(observer, id))[0]?.state === 'completed',
          15_000,
        );
        await sleep(1500);
        return {
          done,
          attempts,
          rows: (await jobRows(observer, id)).map((row) => [row.queue, row.state, row.retryCount]),
          dead: await deadCopies(observer, id),
          lines: w.lines.map(reduceLine),
          expectedLines: [
            line(
              'worker',
              'warn',
              { queue: 't-std', jobName: 'order.updated', jobId: id, attempt: 1 },
              'job_failed',
            ),
          ],
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toMatchObject({
    done: true,
    attempts: [1, 2],
    rows: [['t-std', 'completed', 1]],
    dead: [],
  });
  const record = seen as { lines?: unknown; expectedLines?: unknown };
  expect(record.lines).toStrictEqual(record.expectedLines);
}, 60_000);

it('[规划/02 §7.1 死信; contract §5] retryLimit 0 的队列：处理器抛错（含非 Error 的抛出值）只调用一次，立刻 failed 进死信，输出固定，日志正好一条 job_failed_final', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const attempts: number[] = [];
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-once': async (job: ReceivedJob) => {
              attempts.push(job.attempt);
              // Not an Error: an object that carries personal data and a toJSON.
              throw Object.assign(Object.create(null) as object, {
                phone: PERSONAL.phone,
                toJSON: () => ({ name: PERSONAL.name }),
              });
            },
          },
        });
        const w = worker;
        await w.runtime.start();
        const id =
          (await w.runtime.send(
            't-once',
            'agent.run_finished',
            { who: PERSONAL.name },
            { trx: null },
          )) ?? '';
        const finished = await waitFor(
          async () => (await deadCopies(observer, id)).length > 0,
          15_000,
        );
        await sleep(1000);
        return {
          finished,
          attempts,
          rows: await jobRows(observer, id),
          dead: await deadCopies(observer, id),
          lines: w.lines.map(reduceLine),
          expectedLines: [
            line(
              'worker',
              'error',
              { queue: 't-once', jobName: 'agent.run_finished', jobId: id, attempt: 1 },
              'job_failed_final',
            ),
          ],
          personalInLogs: Object.values(PERSONAL).filter((value) => allText(w).includes(value)),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toMatchObject({
    finished: true,
    attempts: [1],
    rows: [{ queue: 't-once', state: 'failed', retryCount: 0, output: OUTPUT, singletonKey: null }],
    dead: [{ queue: 'test-dead', state: 'created', sourceName: 't-once', output: OUTPUT }],
    personalInLogs: [],
  });
  const record = seen as { lines?: unknown; expectedLines?: unknown };
  expect(record.lines).toStrictEqual(record.expectedLines);
}, 60_000);

it('[规划/02 §11 消费幂等; ADR-0001 §3] 处理器在成功的副作用之后抛错：任务被再次投递（至少一次），处理器靠 processed_events(consumer, event_id) 在同一事务去重，副作用只生效一次', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const attempts: number[] = [];
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-std': async (job: ReceivedJob) => {
              attempts.push(job.attempt);
              const w = worker as Setup;
              await w.handles.db.transaction().execute(async (trx) => {
                await trx
                  .insertInto('processed_events')
                  .values({ consumer: 'push', event_id: job.id })
                  .onConflict((conflict) => conflict.doNothing())
                  .execute();
              });
              // The effect committed, then the process "fails" before the job is completed.
              if (job.attempt === 1) throw new Error('lost the completion');
            },
          },
        });
        const w = worker;
        await w.runtime.start();
        const id = (await w.runtime.send('t-std', 'order.credited', {}, { trx: null })) ?? '';
        const done = await waitFor(
          async () => (await jobRows(observer, id))[0]?.state === 'completed',
          15_000,
        );
        const effects = await w.handles.db
          .selectFrom('processed_events')
          .select('consumer')
          .where('event_id', '=', id)
          .execute();
        return { done, attempts, effects: effects.map((row) => row.consumer) };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({ done: true, attempts: [1, 2], effects: ['push'] });
}, 60_000);
