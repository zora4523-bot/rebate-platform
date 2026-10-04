// Rule tests of consuming domain events against a real PostgreSQL (规划/02 §11「消费幂等：processed_events
// (consumer, event_id) 唯一，与副作用同事务写入」「至少一次投递」, §18 领域事件一行; ADR-0001 §3「至少一次投递 →
// 消费端 processed_events(consumer, event_id) 去重」; 规划/04 §3.2 processed_events 行; contract section 8
// of apps/api/src/modules/platform/events/index.ts). Every test gets its own clone of the migrated
// template (ADR-0001 §4.2 #9) and connects as couli_app. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  registerEventConsumer,
  type EventHandler,
  type ReceivedEvent,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { gate, line, memoryLogger, observe, reduceLine, sleep, waitFor } from '../queue/kit.ts';
import {
  closeObserver,
  deadCopies,
  jobRows,
  observerOn,
  setupOn,
  teardown,
  type Setup,
} from '../queue/int-kit.ts';
import { EVT_CATALOG, EVT_PLAN, SUBS, describeError } from './kit.ts';
import { INSTANT, busOn, clockAt, effect, effects, infoLine, processed } from './int-kit.ts';

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** Ids only, but distinctive: none of them may appear in a log line. */
const PAYLOAD = { order_id: 'ORD-77125-QX', user_id: 'USR-50311-KM', amount_fen: 98_765 };
const MARKERS = ['ORD-77125-QX', 'USR-50311-KM', '98765'];

/** A handler failure whose message and properties repeat the payload. */
class LeakyFailure extends Error {
  readonly detail = PAYLOAD;

  constructor() {
    super(`cannot handle ${PAYLOAD.order_id} for ${PAYLOAD.user_id}`);
    this.name = 'LeakyFailure';
  }
}

/** A consumer handler that records each event (shape, frozenness) and writes one effect. */
function recording(
  consumer: string,
  failOn: (attempt: number) => boolean = () => false,
): { events: unknown[]; attempts: number[]; handler: EventHandler } {
  const events: unknown[] = [];
  const attempts: number[] = [];
  return {
    events,
    attempts,
    handler: async (event: ReceivedEvent, trx) => {
      attempts.push(event.attempt);
      events.push({
        keys: Reflect.ownKeys(event).map(String).sort(),
        frozen: Object.isFrozen(event),
        plain: Object.getPrototypeOf(event) === Object.prototype,
        trx: (trx as unknown as { isTransaction?: unknown }).isTransaction,
        ...event,
      });
      await effect(trx, `${consumer}:${event.eventId}`);
      if (failOn(event.attempt)) throw new LeakyFailure();
    },
  };
}

/** A worker runtime with the events catalog and an api-like bus on its own runtime. */
async function start(
  database: TestDatabase,
  consumers: Record<string, EventHandler>,
): Promise<{ worker: Setup; api: Setup; publish: (eventId?: string) => Promise<string> }> {
  const worker = setupOn(database, 'worker', { catalog: EVT_CATALOG, plan: EVT_PLAN });
  for (const [consumer, handler] of Object.entries(consumers)) {
    registerEventConsumer(worker.runtime, {
      consumer,
      db: worker.handles.db,
      logger: worker.logger,
      handler,
      subscriptions: SUBS,
    });
  }
  const made = busOn(database, 'api', clockAt(INSTANT).clock);
  await made.setup.runtime.start();
  await worker.runtime.start();
  return {
    worker,
    api: made.setup,
    publish: async (eventId?: string) =>
      made.setup.handles.db.transaction().execute(async (trx) => {
        const result = await made.bus.publish(trx, {
          appId: 'couli',
          name: 'order.created',
          payload: PAYLOAD,
          ...(eventId === undefined ? {} : { eventId }),
        });
        return result.eventId;
      }),
  };
}

function expectedEvent(
  eventId: string,
  consumer: string,
  attempt: number,
): Record<string, unknown> {
  return {
    keys: ['appId', 'attempt', 'consumer', 'eventId', 'name', 'occurredAt', 'payload', 'version'],
    frozen: true,
    plain: true,
    trx: true,
    eventId,
    appId: 'couli',
    name: 'order.created',
    version: 1,
    occurredAt: INSTANT,
    payload: PAYLOAD,
    consumer,
    attempt,
  };
}

function leaked(setup: Setup): string[] {
  const all = setup.lines.join('');
  return MARKERS.filter((marker) => all.includes(marker));
}

it('[规划/02 §11 消费幂等; ADR-0001 §3; contract §8] 端到端：api 发布、worker 消费，每个订阅者的处理器正好被调用一次，收到确切的冻结事件对象与事务；processed_events 正好 (alpha, id)、(beta, id)；副作用各一次；任务 completed；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let setups: Setup[] = [];
    const alpha = recording('alpha');
    const beta = recording('beta');
    try {
      return await observe(async () => {
        const started = await start(database, { alpha: alpha.handler, beta: beta.handler });
        setups = [started.worker, started.api];
        const eventId = await started.publish();
        await waitFor(
          async () =>
            (await jobRows(observer, eventId)).filter((row) => row.state === 'completed').length ===
            2,
          15_000,
        );
        await sleep(1000);
        return {
          eventId,
          alpha: alpha.events,
          beta: beta.events,
          processed: await processed(observer),
          effects: [
            await effects(observer, `alpha:${eventId}`),
            await effects(observer, `beta:${eventId}`),
          ],
          states: (await jobRows(observer, eventId)).map((row) => [row.queue, row.state]),
          lines: [...started.worker.lines, ...started.api.lines],
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    alpha: [expectedEvent(eventId, 'alpha', 1)],
    beta: [expectedEvent(eventId, 'beta', 1)],
    processed: [
      ['alpha', eventId],
      ['beta', eventId],
    ],
    effects: [1, 1],
    states: [
      ['evt.alpha', 'completed'],
      ['evt.beta', 'completed'],
    ],
    lines: [],
  });
}, 60_000);

/** Registers `consumer` on a fake runtime and returns the job handler it registered. */
function captured(
  database: { db: Setup['handles']['db'] },
  consumer: string,
  handler: EventHandler,
  logger: Setup['logger'],
): JobHandler {
  const handlers: JobHandler[] = [];
  registerEventConsumer(
    {
      register: (_queue: string, jobHandler: JobHandler) => {
        handlers.push(jobHandler);
      },
    },
    { consumer, db: database.db, logger, handler, subscriptions: SUBS },
  );
  const jobHandler = handlers[0];
  if (jobHandler === undefined) throw new Error('nothing registered');
  return jobHandler;
}

function jobOf(eventId: string, queue: string, attempt: number): Parameters<JobHandler>[0] {
  return Object.freeze({
    id: eventId,
    queue,
    name: 'order.created',
    payload: { app_id: 'couli', v: 1, occurred_at: INSTANT, data: PAYLOAD },
    attempt,
  });
}

it('[规划/02 §11 消费幂等; ADR-0001 §3 至少一次投递] 同一任务重复投递（依次三次）：处理器只调用一次、副作用一次、processed_events 一行；后两次直接完成并各写一条 event_duplicate（info，字段正好 consumer、eventId、eventName、attempt）；另一消费者同一 event_id 照常生效', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { catalog: EVT_CATALOG, plan: EVT_PLAN });
        const w = worker;
        const alpha = recording('alpha');
        const beta = recording('beta');
        const alphaJobs = captured(w.handles, 'alpha', alpha.handler, w.logger);
        const betaJobs = captured(w.handles, 'beta', beta.handler, w.logger);
        const eventId = randomUUID();
        const outcomes = [];
        for (const attempt of [1, 2, 3]) {
          outcomes.push(await alphaJobs(jobOf(eventId, 'evt.alpha', attempt)).then(String));
        }
        outcomes.push(await betaJobs(jobOf(eventId, 'evt.beta', 1)).then(String));
        return {
          eventId,
          outcomes,
          alphaAttempts: alpha.attempts,
          betaAttempts: beta.attempts,
          processed: await processed(observer),
          effects: [
            await effects(observer, `alpha:${eventId}`),
            await effects(observer, `beta:${eventId}`),
          ],
          lines: w.lines.map(reduceLine),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    outcomes: ['undefined', 'undefined', 'undefined', 'undefined'],
    alphaAttempts: [1],
    betaAttempts: [1],
    processed: [
      ['alpha', eventId],
      ['beta', eventId],
    ],
    effects: [1, 1],
    lines: [2, 3].map((attempt) =>
      infoLine(
        { consumer: 'alpha', eventId, eventName: 'order.created', attempt },
        'event_duplicate',
      ),
    ),
  });
}, 60_000);

it('[规划/02 §11 消费幂等; contract §8.2] 同一任务并发投递两次：第二次等第一次的事务结束后才判定，处理器只调用一次、副作用一次、processed_events 一行，两次都完成，正好一条 event_duplicate', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { catalog: EVT_CATALOG, plan: EVT_PLAN });
        const w = worker;
        const inside = gate();
        const release = gate();
        const attempts: number[] = [];
        const jobs = captured(
          w.handles,
          'alpha',
          async (event, trx) => {
            attempts.push(event.attempt);
            await effect(trx, `alpha:${event.eventId}`);
            inside.open();
            await release.wait();
          },
          w.logger,
        );
        const eventId = randomUUID();
        const first = jobs(jobOf(eventId, 'evt.alpha', 1)).then(
          () => 'resolved',
          (error: unknown) => describeError(error),
        );
        await inside.wait();
        let secondDone = false;
        const second = jobs(jobOf(eventId, 'evt.alpha', 2)).then(
          () => {
            secondDone = true;
            return 'resolved';
          },
          (error: unknown) => describeError(error),
        );
        await sleep(500);
        const secondBeforeRelease = secondDone;
        release.open();
        return {
          eventId,
          outcomes: await Promise.all([first, second]),
          secondBeforeRelease,
          attempts,
          processed: await processed(observer),
          effects: await effects(observer, `alpha:${eventId}`),
          lines: w.lines.map(reduceLine),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    outcomes: ['resolved', 'resolved'],
    secondBeforeRelease: false,
    attempts: [1],
    processed: [['alpha', eventId]],
    effects: 1,
    lines: [
      infoLine(
        { consumer: 'alpha', eventId, eventName: 'order.created', attempt: 2 },
        'event_duplicate',
      ),
    ],
  });
}, 60_000);

it('[规划/02 §11 与副作用同事务写入; contract §8.3] 处理器写了副作用后抛错：整个事务回滚（没有副作用、没有 processed_events 行），任务处理函数以同一个错误对象拒绝；下一次投递成功后正好生效一次；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { catalog: EVT_CATALOG, plan: EVT_PLAN });
        const w = worker;
        const thrown: unknown[] = [];
        const alpha = recording('alpha', (attempt) => attempt === 1);
        const jobs = captured(
          w.handles,
          'alpha',
          async (event, trx) => {
            try {
              await alpha.handler(event, trx);
            } catch (error) {
              thrown.push(error);
              throw error;
            }
          },
          w.logger,
        );
        const eventId = randomUUID();
        const rejection = await jobs(jobOf(eventId, 'evt.alpha', 1)).then(
          () => 'resolved',
          (error: unknown) => error,
        );
        const afterFailure = {
          processed: await processed(observer),
          effects: await effects(observer, `alpha:${eventId}`),
        };
        const second = await jobs(jobOf(eventId, 'evt.alpha', 2)).then(
          () => 'resolved',
          (error: unknown) => describeError(error),
        );
        return {
          eventId,
          sameError: thrown.length === 1 && rejection === thrown[0],
          afterFailure,
          second,
          attempts: alpha.attempts,
          processed: await processed(observer),
          effects: await effects(observer, `alpha:${eventId}`),
          lines: w.lines,
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    sameError: true,
    afterFailure: { processed: [], effects: 0 },
    second: 'resolved',
    attempts: [1, 2],
    processed: [['alpha', eventId]],
    effects: 1,
    lines: [],
  });
}, 60_000);

it('[ADR-0001 §3 至少一次投递; 规划/02 §11 消费幂等] 经真实队列：alpha 第一次失败（已写的副作用回滚）、按队列设置重试后成功，最终副作用正好一次；beta 不受影响；日志只有队列的一条 job_failed，不含负载与错误内容', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let setups: Setup[] = [];
    const alpha = recording('alpha', (attempt) => attempt === 1);
    const beta = recording('beta');
    try {
      return await observe(async () => {
        const started = await start(database, { alpha: alpha.handler, beta: beta.handler });
        setups = [started.worker, started.api];
        const eventId = await started.publish();
        const done = await waitFor(
          async () =>
            (await jobRows(observer, eventId)).filter((row) => row.state === 'completed').length ===
            2,
          20_000,
        );
        await sleep(1500);
        return {
          eventId,
          done,
          alphaAttempts: alpha.attempts,
          betaAttempts: beta.attempts,
          rows: (await jobRows(observer, eventId)).map((row) => [
            row.queue,
            row.state,
            row.retryCount,
          ]),
          processed: await processed(observer),
          effects: [
            await effects(observer, `alpha:${eventId}`),
            await effects(observer, `beta:${eventId}`),
          ],
          lines: started.worker.lines.map(reduceLine),
          leaked: leaked(started.worker),
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    done: true,
    alphaAttempts: [1, 2],
    betaAttempts: [1],
    rows: [
      ['evt.alpha', 'completed', 1],
      ['evt.beta', 'completed', 0],
    ],
    processed: [
      ['alpha', eventId],
      ['beta', eventId],
    ],
    effects: [1, 1],
    lines: [
      line(
        'worker',
        'warn',
        { queue: 'evt.alpha', jobName: 'order.created', jobId: eventId, attempt: 1 },
        'job_failed',
      ),
    ],
    leaked: [],
  });
}, 60_000);

it('[规划/02 §7.1 死信、§11; ADR-0001 §3] 消费者之间互不影响：alpha 每次都失败，按 retryLimit 共 3 次后 failed 并进死信、没有副作用、没有 processed_events 行；beta 一次完成并生效；日志正好两条 job_failed 与一条 job_failed_final，不含负载与错误内容', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let setups: Setup[] = [];
    const alpha = recording('alpha', () => true);
    const beta = recording('beta');
    try {
      return await observe(async () => {
        const started = await start(database, { alpha: alpha.handler, beta: beta.handler });
        setups = [started.worker, started.api];
        const eventId = await started.publish();
        const finished = await waitFor(
          async () => (await deadCopies(observer, eventId)).length > 0,
          20_000,
        );
        await sleep(1500);
        return {
          eventId,
          finished,
          alphaAttempts: alpha.attempts,
          betaAttempts: beta.attempts,
          rows: (await jobRows(observer, eventId)).map((row) => [row.queue, row.state]),
          dead: (await deadCopies(observer, eventId)).map((row) => [row.queue, row.sourceName]),
          processed: await processed(observer),
          effects: [
            await effects(observer, `alpha:${eventId}`),
            await effects(observer, `beta:${eventId}`),
          ],
          lines: started.worker.lines.map(reduceLine),
          leaked: leaked(started.worker),
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    finished: true,
    alphaAttempts: [1, 2, 3],
    betaAttempts: [1],
    rows: [
      ['evt.alpha', 'failed'],
      ['evt.beta', 'completed'],
    ],
    dead: [['test-dead', 'evt.alpha']],
    processed: [['beta', eventId]],
    effects: [0, 1],
    lines: [1, 2, 3].map((attempt) =>
      line(
        'worker',
        attempt === 3 ? 'error' : 'warn',
        { queue: 'evt.alpha', jobName: 'order.created', jobId: eventId, attempt },
        attempt === 3 ? 'job_failed_final' : 'job_failed',
      ),
    ),
    leaked: [],
  });
}, 60_000);

it('[规划/02 §11 消费幂等; 规划/04 §3.2 processed_events] 去重键是 (consumer, event_id)：alpha 已处理过该 event_id 时，经真实队列投递的 alpha 任务不调处理器、直接完成并写一条 event_duplicate；beta 照常处理', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let setups: Setup[] = [];
    const alpha = recording('alpha');
    const beta = recording('beta');
    try {
      return await observe(async () => {
        const started = await start(database, { alpha: alpha.handler, beta: beta.handler });
        setups = [started.worker, started.api];
        const eventId = randomUUID();
        await observer
          .insertInto('processed_events')
          .values({ consumer: 'alpha', event_id: eventId })
          .execute();
        await started.publish(eventId);
        await waitFor(
          async () =>
            (await jobRows(observer, eventId)).filter((row) => row.state === 'completed').length ===
            2,
          15_000,
        );
        await sleep(1000);
        return {
          eventId,
          alphaAttempts: alpha.attempts,
          betaAttempts: beta.attempts,
          states: (await jobRows(observer, eventId)).map((row) => [row.queue, row.state]),
          processed: await processed(observer),
          effects: [
            await effects(observer, `alpha:${eventId}`),
            await effects(observer, `beta:${eventId}`),
          ],
          lines: started.worker.lines.map(reduceLine),
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    alphaAttempts: [],
    betaAttempts: [1],
    states: [
      ['evt.alpha', 'completed'],
      ['evt.beta', 'completed'],
    ],
    processed: [
      ['alpha', eventId],
      ['beta', eventId],
    ],
    effects: [0, 1],
    lines: [
      infoLine(
        { consumer: 'alpha', eventId, eventName: 'order.created', attempt: 1 },
        'event_duplicate',
      ),
    ],
  });
}, 60_000);

it('[contract §8 日志] event_duplicate 一行只经 options.logger 本身输出（不用子 logger、不加绑定），字段之外不含负载、app_id 与其他内容', async () => {
  const seen = await withDatabase(async (database) => {
    let worker: Setup | undefined;
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', { catalog: EVT_CATALOG, plan: EVT_PLAN });
        const w = worker;
        const own = memoryLogger('worker');
        const jobs = captured(w.handles, 'beta', async () => undefined, own.logger);
        const eventId = randomUUID();
        await jobs(jobOf(eventId, 'evt.beta', 1));
        await jobs(jobOf(eventId, 'evt.beta', 4));
        return {
          eventId,
          lines: own.lines.map(reduceLine),
          raw:
            own.lines.join('').includes('couli') ||
            MARKERS.some((m) => own.lines.join('').includes(m)),
          runtimeLines: w.lines,
        };
      });
    } finally {
      await teardown([worker]);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    lines: [
      infoLine(
        { consumer: 'beta', eventId, eventName: 'order.created', attempt: 4 },
        'event_duplicate',
      ),
    ],
    raw: false,
    runtimeLines: [],
  });
}, 60_000);
