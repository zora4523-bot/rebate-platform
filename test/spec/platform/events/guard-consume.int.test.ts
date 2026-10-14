// B1-01zv 台账②③：吞掉 SQL 错误不能完成任务；生产与消费的时刻范围一致。
// 时间依据：validation.ts instant 接受 0..2^48−1 毫秒，events.ts 使用 toISOString() 生成信封；
// events/index.ts §3、§4 明文保证该范围，因此选择保留生产端范围、消费端接受扩展年份。
// 本测试以 §4d 的信封格式直接投递 §8 注册的处理函数，隔离旧四位年份正则的问题。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  newEventId,
  registerEventConsumer,
  type ReceivedEvent,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  closeObserver,
  jobRows,
  observerOn,
  setupOn,
  teardown,
  type Setup,
} from '../queue/int-kit.ts';
import { memoryLogger, waitFor } from '../queue/kit.ts';
import { busOn, clockAt, effect, effects, INSTANT, processed } from './int-kit.ts';
import { EVT_CATALOG, EVT_PLAN, settled, SUBS } from './kit.ts';

it('[AC-B1-01zv#3] handler 吞掉事务 SQL 错误并返回：任务重试后成功，副作用与处理标记恰好一次', async () => {
  const database = await createTestDatabase();
  const observer = observerOn(database);
  const { setup: api, bus } = busOn(database, 'api', clockAt(INSTANT).clock);
  let worker: Setup | undefined;
  try {
    await api.runtime.start();
    const eventId = randomUUID();
    await api.handles.db.transaction().execute(async (trx) => {
      await bus.publish(trx, {
        eventId,
        appId: 'couli',
        name: 'order.updated',
        payload: { order_id: 'guard-3' },
      });
    });
    worker = setupOn(database, 'worker', {
      catalog: EVT_CATALOG,
      plan: EVT_PLAN,
      handlers: { 'evt.beta': async () => {} },
    });
    const attempts: number[] = [];
    const swallowedCodes: unknown[] = [];
    const beforeSecondAttempt: unknown[] = [];
    registerEventConsumer(worker.runtime, {
      consumer: 'alpha',
      db: worker.handles.db,
      logger: worker.logger,
      subscriptions: SUBS,
      handler: async (event, trx) => {
        attempts.push(event.attempt);
        if (attempts.length > 1) {
          beforeSecondAttempt.push({
            effects: await effects(observer, 'swallowed-sql'),
            processed: await processed(observer),
          });
        }
        await effect(trx, 'swallowed-sql');
        if (attempts.length === 1) {
          try {
            await sql`SELECT 1 / 0`.execute(trx);
          } catch (error) {
            // 模拟业务 handler 误吞 PG 错误，正常返回；不得在这里再抛出或主动回滚。
            swallowedCodes.push(
              error !== null && typeof error === 'object' && 'code' in error ? error.code : null,
            );
          }
        }
      },
    });
    await worker.runtime.start();
    // 旧实现会很快进入 completed，修复后第二次尝试进入 completed；两者都结束轮询。
    const terminal = await waitFor(async () => {
      const rows = await jobRows(observer, eventId);
      return rows.some(
        (row) => row.queue === 'evt.alpha' && ['completed', 'failed'].includes(row.state),
      );
    }, 30_000);

    expect(terminal).toBe(true);
    expect(swallowedCodes).toStrictEqual(['22012']);
    expect(attempts).toStrictEqual([1, 2]);
    expect(beforeSecondAttempt).toStrictEqual([{ effects: 0, processed: [] }]);
    expect(await jobRows(observer, eventId)).toMatchObject([
      { queue: 'evt.alpha', state: 'completed', retryCount: 1 },
    ]);
    expect(await effects(observer, 'swallowed-sql')).toBe(1);
    expect(await processed(observer)).toStrictEqual([['alpha', eventId]]);
  } finally {
    await teardown([worker, api]);
    await closeObserver(observer);
    await database.drop();
  }
}, 60_000);

it.each([
  ['首个扩展年份', 253_402_300_800_000],
  ['最大允许毫秒', 2 ** 48 - 1],
] as const)(
  '[AC-B1-01zv#4] %s 的生产端时刻可被消费，原样传给 handler 并提交副作用',
  async (_label, milliseconds) => {
    const database = await createTestDatabase();
    const db = observerOn(database);
    try {
      const now = new Date(milliseconds);
      const occurredAt = now.toISOString();
      const eventId = newEventId(now);
      const handlers: JobHandler[] = [];
      const received: ReceivedEvent[] = [];
      registerEventConsumer(
        { register: (_queue, handler) => void handlers.push(handler) },
        {
          consumer: 'alpha',
          db,
          logger: memoryLogger('worker').logger,
          subscriptions: SUBS,
          handler: async (event, trx) => {
            received.push(event);
            await effect(trx, 'extended-year');
          },
        },
      );
      expect(handlers).toHaveLength(1);
      const outcomes: string[] = [];
      for (const handler of handlers) {
        outcomes.push(
          await settled(
            handler({
              id: eventId,
              queue: 'evt.alpha',
              name: 'order.updated',
              attempt: 1,
              payload: {
                app_id: 'couli',
                v: 1,
                occurred_at: occurredAt,
                data: { order_id: 'guard-4' },
              },
            }),
          ),
        );
      }

      expect(outcomes).toStrictEqual(['resolved']);
      expect(received).toStrictEqual([
        {
          eventId,
          appId: 'couli',
          name: 'order.updated',
          version: 1,
          occurredAt,
          payload: { order_id: 'guard-4' },
          consumer: 'alpha',
          attempt: 1,
        },
      ]);
      expect(await effects(db, 'extended-year')).toBe(1);
      expect(await processed(db)).toStrictEqual([['alpha', eventId]]);
    } finally {
      await closeObserver(db);
      await database.drop();
    }
  },
  30_000,
);
