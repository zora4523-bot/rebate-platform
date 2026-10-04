// Rule tests of publishing domain events against a real PostgreSQL (规划/02 §11「同事务入队」「按消费者进入
// evt.<consumer> 队列，任务 ID = event_id」「事务提交后才可被取走」「事件留痕」, §18 领域事件一行; ADR-0001 §3,
// §4.2 第 10 项 时钟, 第 16 项 event_log; 规划/04 §3.2 event_log 行; contract sections 2–5 of
// apps/api/src/modules/platform/events/index.ts). Every test gets its own clone of the migrated
// template (ADR-0001 §4.2 #9) and connects as couli_app. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { gate, observe, sleep, waitFor } from '../queue/kit.ts';
import { closeObserver, jobRows, observerOn, teardown, type Setup } from '../queue/int-kit.ts';
import { UUID_V7, eventErrorProblems, payloadOfBytes, settled, text, uuidMs } from './kit.ts';
import {
  INSTANT,
  busOn,
  clockAt,
  effect,
  effects,
  eventLog,
  evtJobs,
  processed,
} from './int-kit.ts';

class Rollback extends Error {}

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

const PAYLOAD = {
  order_id: '0190a6a0-0000-7000-8000-0000000000aa',
  user_id: '0190a6a0-0000-7000-8000-0000000000bb',
  amount_fen: 12_345,
  platform: 'taobao',
  flags: [true, false, null],
};

const FRESH = { queue: '', state: 'created', retryCount: 0, output: null, singletonKey: null };

it('[规划/02 §11 同事务入队、事件留痕; ADR-0001 §4.2 #10、#16; contract §4、§5] 提交：返回冻结的 { eventId, duplicate: false }，eventId 是 UUIDv7 且毫秒等于时钟；event_log 正好一行、字段确切（payload 为 {v, data}，occurred_at 取时钟而非数据库时间）；每个订阅者正好一个 created 任务、id = event_id；提交前别的连接看不到行与任务；时钟只读一次；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const { clock, reads } = clockAt(INSTANT);
        const made = busOn(database, 'api', clock);
        api = made.setup;
        await api.runtime.start();
        let beforeCommit: unknown = null;
        const result = await api.handles.db.transaction().execute(async (trx) => {
          await effect(trx, 'business');
          const published = await made.bus.publish(trx, {
            appId: 'couli',
            name: 'order.created',
            payload: PAYLOAD,
          });
          beforeCommit = {
            log: await eventLog(observer),
            jobs: await evtJobs(observer),
            business: await effects(observer, 'business'),
          };
          return published;
        });
        const eventId = result.eventId;
        return {
          result,
          frozen: Object.isFrozen(result),
          keys: Reflect.ownKeys(result).map(String).sort(),
          v7: UUID_V7.test(eventId),
          ms: uuidMs(eventId) === Date.parse(INSTANT),
          beforeCommit,
          log: await eventLog(observer),
          jobs: await jobRows(observer, eventId),
          allJobs: (await evtJobs(observer)).length,
          business: await effects(observer, 'business'),
          reads: reads(),
          lines: api.lines,
          eventId,
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  expect(seen).toStrictEqual({
    result: { eventId, duplicate: false },
    frozen: true,
    keys: ['duplicate', 'eventId'],
    v7: true,
    ms: true,
    beforeCommit: { log: [], jobs: [], business: 0 },
    log: [
      {
        appId: 'couli',
        eventId,
        name: 'order.created',
        payload: { v: 1, data: PAYLOAD },
        occurredAt: INSTANT,
        createdAt: true,
      },
    ],
    jobs: [
      { ...FRESH, queue: 'evt.alpha' },
      { ...FRESH, queue: 'evt.beta' },
    ],
    allJobs: 2,
    business: 1,
    reads: 1,
    lines: [],
    eventId,
  });
}, 60_000);

it('[规划/02 §11 同事务入队; ADR-0001 §3] 回滚：业务写入与发布同一事务，事务回滚后没有 event_log 行、没有任何 evt.* 任务、业务行也不在', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const made = busOn(database, 'api', clockAt(INSTANT).clock);
        api = made.setup;
        await api.runtime.start();
        let eventId = '';
        const outcome = await api.handles.db
          .transaction()
          .execute(async (trx) => {
            await effect(trx, 'business');
            eventId = (
              await made.bus.publish(trx, {
                appId: 'couli',
                name: 'order.created',
                payload: PAYLOAD,
              })
            ).eventId;
            throw new Rollback();
          })
          .catch((error: unknown) => error);
        return {
          rolledBack: outcome instanceof Rollback,
          published: UUID_V7.test(eventId),
          log: await eventLog(observer),
          jobs: await evtJobs(observer),
          byId: await jobRows(observer, eventId === '' ? randomUUID() : eventId),
          business: await effects(observer, 'business'),
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  expect(seen).toStrictEqual({
    rolledBack: true,
    published: true,
    log: [],
    jobs: [],
    byId: [],
    business: 0,
  });
}, 60_000);

it('[规划/02 §11 按消费者入队; contract §4d、§6] 路由：只订阅者得到任务（order.updated 只给 alpha，member.registered 只给 beta，无人订阅的 order.credited 只留 event_log 行）；调用方给的 eventId 原样用作 event_id 与任务 id；version 写进 payload.v', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const made = busOn(database, 'api', clockAt(INSTANT).clock);
        api = made.setup;
        await api.runtime.start();
        const ids = { updated: randomUUID(), registered: randomUUID(), credited: randomUUID() };
        const results = await api.handles.db.transaction().execute(async (trx) => [
          await made.bus.publish(trx, {
            appId: 'couli',
            name: 'order.updated',
            payload: { order_id: PAYLOAD.order_id },
            eventId: ids.updated,
            version: 2,
          }),
          await made.bus.publish(trx, {
            appId: 'brand-b',
            name: 'member.registered',
            payload: { user_id: PAYLOAD.user_id },
            eventId: ids.registered,
          }),
          await made.bus.publish(trx, {
            appId: 'couli',
            name: 'order.credited',
            payload: { order_id: PAYLOAD.order_id },
            eventId: ids.credited,
          }),
        ]);
        return {
          ids,
          results: results.map((result) => ({ ...result })),
          log: (await eventLog(observer)).map((row) => [
            row.eventId,
            row.appId,
            row.name,
            row.payload,
          ]),
          jobs: await evtJobs(observer),
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  const ids = (seen as { ids?: Record<string, string> }).ids ?? {};
  const [updated, registered, credited] = [ids.updated, ids.registered, ids.credited];
  expect(seen).toStrictEqual({
    ids,
    results: [
      { eventId: updated, duplicate: false },
      { eventId: registered, duplicate: false },
      { eventId: credited, duplicate: false },
    ],
    log: [
      [updated, 'couli', 'order.updated', { v: 2, data: { order_id: PAYLOAD.order_id } }],
      [registered, 'brand-b', 'member.registered', { v: 1, data: { user_id: PAYLOAD.user_id } }],
      [credited, 'couli', 'order.credited', { v: 1, data: { order_id: PAYLOAD.order_id } }],
    ],
    jobs: [
      ['evt.alpha', updated, 'created'],
      ['evt.beta', registered, 'created'],
    ],
  });
}, 60_000);

it('[规划/02 §11 任务 ID = event_id; contract §4b] 重复发布同一 event_id：内容相同时（另一事务、时钟已前进，或同一事务再发）返回 duplicate: true，不新增 event_log 行、不新增任务，occurred_at 保持第一次；内容不同（payload、名字、版本、appId）拒绝 event_conflict，什么都不写，事务仍可继续提交', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const time = clockAt(INSTANT);
        const made = busOn(database, 'api', time.clock);
        api = made.setup;
        const a = api;
        await a.runtime.start();
        const eventId = randomUUID();
        const base = { appId: 'couli', name: 'order.created', payload: PAYLOAD, eventId };
        const first = await a.handles.db
          .transaction()
          .execute(async (trx) => ({ ...(await made.bus.publish(trx, base)) }));
        const jobsAfterFirst = await evtJobs(observer);
        time.fixed.set('2031-02-04T00:00:00.000Z');
        const again = await a.handles.db
          .transaction()
          .execute(async (trx) => ({ ...(await made.bus.publish(trx, { ...base, version: 1 })) }));
        const conflicts: string[][] = [];
        for (const changed of [
          { payload: { ...PAYLOAD, amount_fen: 1 } },
          { name: 'order.updated' },
          { version: 2 },
          { appId: 'brand-b' },
        ]) {
          const tag = `after-conflict-${conflicts.length}`;
          conflicts.push(
            await a.handles.db.transaction().execute(async (trx) => {
              let problems: string[];
              try {
                await made.bus.publish(trx, { ...base, ...changed });
                problems = ['resolved'];
              } catch (error) {
                problems = eventErrorProblems(error, 'event_conflict');
              }
              await effect(trx, tag);
              return problems;
            }),
          );
        }
        const sameTrxId = randomUUID();
        const sameTrx = await a.handles.db.transaction().execute(async (trx) => {
          const one = await made.bus.publish(trx, { ...base, eventId: sameTrxId });
          const two = await made.bus.publish(trx, { ...base, eventId: sameTrxId });
          return [{ ...one }, { ...two }];
        });
        return {
          eventId,
          sameTrxId,
          first,
          again,
          conflicts,
          sameTrx,
          afterConflict: await Promise.all(
            [0, 1, 2, 3].map(async (index) => effects(observer, `after-conflict-${index}`)),
          ),
          log: (await eventLog(observer)).map((row) => [row.eventId, row.occurredAt, row.payload]),
          jobsAfterFirst,
          jobs: (await evtJobs(observer)).filter(([, id]) => id === eventId),
          sameTrxJobs: (await evtJobs(observer)).filter(([, id]) => id === sameTrxId),
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  const record = seen as { eventId?: string; sameTrxId?: string };
  const eventId = record.eventId ?? 'missing';
  const sameTrxId = record.sameTrxId ?? 'missing';
  expect(seen).toStrictEqual({
    eventId,
    sameTrxId,
    first: { eventId, duplicate: false },
    again: { eventId, duplicate: true },
    conflicts: [[], [], [], []],
    // The second publish of one event_id in one transaction is a duplicate.
    sameTrx: [
      { eventId: sameTrxId, duplicate: false },
      { eventId: sameTrxId, duplicate: true },
    ],
    afterConflict: [1, 1, 1, 1],
    log: [
      [eventId, INSTANT, { v: 1, data: PAYLOAD }],
      [sameTrxId, '2031-02-04T00:00:00.000Z', { v: 1, data: PAYLOAD }],
    ],
    jobsAfterFirst: [
      ['evt.alpha', eventId, 'created'],
      ['evt.beta', eventId, 'created'],
    ],
    jobs: [
      ['evt.alpha', eventId, 'created'],
      ['evt.beta', eventId, 'created'],
    ],
    sameTrxJobs: [
      ['evt.alpha', sameTrxId, 'created'],
      ['evt.beta', sameTrxId, 'created'],
    ],
  });
}, 60_000);

it('[规划/02 §11 任务 ID = event_id; contract §4a] 两个事务并发发布同一 event_id：先发布的提交后，后者得到 duplicate: true，最终 event_log 一行、每个订阅者一个任务；先发布的回滚时，后者照常发布（duplicate: false），提交后同样一行、每订阅者一个任务', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const made = busOn(database, 'api', clockAt(INSTANT).clock);
        api = made.setup;
        const a = api;
        await a.runtime.start();
        const race = async (firstCommits: boolean): Promise<Record<string, unknown>> => {
          const eventId = randomUUID();
          const event = { appId: 'couli', name: 'order.created', payload: PAYLOAD, eventId };
          const published = gate();
          const finish = gate();
          const first = a.handles.db
            .transaction()
            .execute(async (trx) => {
              await made.bus.publish(trx, event);
              published.open();
              await finish.wait();
              if (!firstCommits) throw new Rollback();
            })
            .catch((error: unknown) => (error instanceof Rollback ? 'rolled back' : String(error)));
          await published.wait();
          let secondResult: unknown = 'pending';
          const second = a.handles.db
            .transaction()
            .execute(async (trx) => ({ ...(await made.bus.publish(trx, event)) }))
            .then((result) => {
              secondResult = result;
            });
          await sleep(500);
          finish.open();
          await Promise.all([first, second]);
          return {
            secondResult,
            log: (await eventLog(observer)).filter((row) => row.eventId === eventId).length,
            jobs: (await evtJobs(observer)).filter(([, id]) => id === eventId),
            eventId,
          };
        };
        return { committed: await race(true), rolledBack: await race(false) };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  const record = seen as {
    committed?: { eventId?: string };
    rolledBack?: { eventId?: string };
  };
  const one = record.committed?.eventId ?? 'missing';
  const two = record.rolledBack?.eventId ?? 'missing';
  expect(seen).toStrictEqual({
    committed: {
      secondResult: { eventId: one, duplicate: true },
      log: 1,
      jobs: [
        ['evt.alpha', one, 'created'],
        ['evt.beta', one, 'created'],
      ],
      eventId: one,
    },
    rolledBack: {
      secondResult: { eventId: two, duplicate: false },
      log: 1,
      jobs: [
        ['evt.alpha', two, 'created'],
        ['evt.beta', two, 'created'],
      ],
      eventId: two,
    },
  });
}, 60_000);

it('[contract §2 检查先于一切] 在真实事务里发布被拒（个人数据、超大、未知事件、非事务）后事务仍可用：之前与之后的业务写入都随提交生效，没有 event_log 行、没有任务', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const made = busOn(database, 'api', clockAt(INSTANT).clock);
        api = made.setup;
        const a = api;
        await a.runtime.start();
        const outcomes = await a.handles.db.transaction().execute(async (trx) => {
          await effect(trx, 'before');
          const results = [
            await settled(
              made.bus.publish(trx, {
                appId: 'couli',
                name: 'member.registered',
                payload: { user_id: PAYLOAD.user_id, phone: '13912345678' },
              }),
            ),
            await settled(
              made.bus.publish(trx, {
                appId: 'couli',
                name: 'order.created',
                payload: payloadOfBytes(4097),
              }),
            ),
            await settled(
              made.bus.publish(trx, { appId: 'couli', name: 'order.paid', payload: PAYLOAD }),
            ),
            await settled(
              made.bus.publish(a.handles.db as never, {
                appId: 'couli',
                name: 'order.created',
                payload: PAYLOAD,
              }),
            ),
          ];
          await effect(trx, 'after');
          return results;
        });
        return {
          outcomes,
          before: await effects(observer, 'before'),
          after: await effects(observer, 'after'),
          log: await eventLog(observer),
          jobs: await evtJobs(observer),
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  expect(seen).toStrictEqual({
    outcomes: [
      'EventError personal_data',
      'EventError payload_too_large',
      'EventError unknown_event',
      'EventError invalid_transaction',
    ],
    before: 1,
    after: 1,
    log: [],
    jobs: [],
  });
}, 60_000);

it('[contract §2 上界] 边界内的事件照常发布并原样留痕：appId 64 个字符、version 999、payload 正好 4096 字节（含多字节字符、128 码元字符串）、第 3 层嵌套、64 字符键、±(2^53−1)、空对象', async () => {
  const deep = {
    order_id: PAYLOAD.order_id,
    [`k${text(63)}`]: 1,
    max: Number.MAX_SAFE_INTEGER,
    min: Number.MIN_SAFE_INTEGER,
    nested: { list: [1, 'x', null, true], inner: { deepest: text(128, '凑') } },
    rows: [{ order_id: PAYLOAD.order_id }, []],
  };
  const exact = payloadOfBytes(4096);
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let api: Setup | undefined;
    try {
      return await observe(async () => {
        const made = busOn(database, 'api', clockAt(INSTANT).clock);
        api = made.setup;
        const a = api;
        await a.runtime.start();
        const ids = await a.handles.db.transaction().execute(async (trx) => {
          const publish = async (event: Parameters<typeof made.bus.publish>[1]) =>
            (await made.bus.publish(trx, event)).eventId;
          return [
            await publish({
              appId: text(64, 'Z'),
              name: 'order.updated',
              payload: {},
              version: 999,
            }),
            await publish({ appId: 'a.b_c-D9', name: 'order.updated', payload: exact }),
            await publish({ appId: 'couli', name: 'order.updated', payload: deep, version: 1 }),
          ];
        });
        return {
          bytes: Buffer.byteLength(JSON.stringify(exact)),
          log: (await eventLog(observer)).map((row) => [row.eventId, row.appId, row.payload]),
          jobs: (await evtJobs(observer)).map(([queue, id]) => [queue, id]),
          ids,
        };
      });
    } finally {
      await teardown([api]);
      await closeObserver(observer);
    }
  });
  const ids = (seen as { ids?: string[] }).ids ?? [];
  expect(seen).toStrictEqual({
    bytes: 4096,
    log: [
      [ids[0], text(64, 'Z'), { v: 999, data: {} }],
      [ids[1], 'a.b_c-D9', { v: 1, data: exact }],
      [ids[2], 'couli', { v: 1, data: deep }],
    ],
    jobs: [...ids].sort().map((id) => ['evt.alpha', id]),
    ids,
  });
}, 60_000);

it('[规划/02 §11 按消费者入队; contract §4d] 订阅者收到的任务确切：每个订阅队列正好一次 { id: event_id, queue, name: 事件名, payload: { app_id, v, occurred_at: 时钟的 ISO 毫秒 Z, data }, attempt: 1 }；无人订阅的事件不投递', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const jobs: ReceivedJob[] = [];
    const collect = async (job: ReceivedJob): Promise<void> => {
      jobs.push(job);
    };
    try {
      return await observe(async () => {
        const made = busOn(database, 'worker', clockAt(INSTANT).clock, {
          'evt.alpha': collect,
          'evt.beta': collect,
        });
        worker = made.setup;
        const w = worker;
        await w.runtime.start();
        const eventId = await w.handles.db.transaction().execute(async (trx) => {
          const created = await made.bus.publish(trx, {
            appId: 'brand-b',
            name: 'order.created',
            payload: PAYLOAD,
            version: 3,
          });
          await made.bus.publish(trx, {
            appId: 'couli',
            name: 'order.credited',
            payload: { order_id: PAYLOAD.order_id },
          });
          return created.eventId;
        });
        await waitFor(() => jobs.length >= 2, 15_000);
        await sleep(1500);
        return {
          eventId,
          jobs: jobs.map((job) => ({ ...job })).sort((x, y) => (x.queue < y.queue ? -1 : 1)),
          processed: await processed(observer),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  const eventId = (seen as { eventId?: string }).eventId ?? 'missing';
  const payload = { app_id: 'brand-b', v: 3, occurred_at: INSTANT, data: PAYLOAD };
  expect(seen).toStrictEqual({
    eventId,
    jobs: [
      { id: eventId, queue: 'evt.alpha', name: 'order.created', payload, attempt: 1 },
      { id: eventId, queue: 'evt.beta', name: 'order.created', payload, attempt: 1 },
    ],
    processed: [],
  });
}, 60_000);
