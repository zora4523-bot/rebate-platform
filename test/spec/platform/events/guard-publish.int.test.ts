// B1-01zv 台账①：同一事务内并行发布同一 eventId 只留一行；拒绝非 READ COMMITTED 发布。
// 依据 events/index.ts §4a–d、§5 的幂等与留痕约定。使用真实事务和队列，避免模拟咨询锁行为。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { closeObserver, observerOn, teardown } from '../queue/int-kit.ts';
import { busOn, clockAt, effect, effects, eventLog, evtJobs, INSTANT } from './int-kit.ts';
import { eventErrorProblems } from './kit.ts';

it('[AC-B1-01zv#1] 同一事务 Promise.all 发布同一 eventId：一个首次发布、一个重复，日志和每个消费者的任务各一份', async () => {
  const database = await createTestDatabase();
  const observer = observerOn(database);
  const { setup, bus } = busOn(database, 'api', clockAt(INSTANT).clock);
  try {
    await setup.runtime.start();
    const eventId = randomUUID();
    const event = {
      eventId,
      appId: 'couli',
      name: 'order.created',
      payload: { order_id: 'guard-1' },
    };
    const results = await setup.handles.db.transaction().execute(async (trx) => {
      await effect(trx, 'parallel-publish');
      return Promise.all([bus.publish(trx, event), bus.publish(trx, event)]);
    });

    // 先检查真实落库结果：队列自身的去重不能掩盖 event_log 多写一行。
    expect(await eventLog(observer)).toStrictEqual([
      {
        appId: 'couli',
        eventId,
        name: 'order.created',
        payload: { v: 1, data: { order_id: 'guard-1' } },
        occurredAt: INSTANT,
        createdAt: true,
      },
    ]);
    expect(results.map((result) => result.eventId)).toStrictEqual([eventId, eventId]);
    expect(results.map((result) => result.duplicate).sort()).toStrictEqual([false, true]);
    expect(await evtJobs(observer)).toStrictEqual([
      ['evt.alpha', eventId, 'created'],
      ['evt.beta', eventId, 'created'],
    ]);
    expect(await effects(observer, 'parallel-publish')).toBe(1);
  } finally {
    await teardown([setup]);
    await closeObserver(observer);
    await database.drop();
  }
}, 60_000);

it.each(['repeatable read', 'serializable'] as const)(
  '[AC-B1-01zv#2] %s 事务发布明确拒绝：即使调用方捕获错误并提交，也不留下事件日志或任务',
  async (isolation) => {
    const database = await createTestDatabase();
    const observer = observerOn(database);
    const { setup, bus } = busOn(database, 'api', clockAt(INSTANT).clock);
    try {
      await setup.runtime.start();
      let failure: unknown;
      await setup.handles.db
        .transaction()
        .setIsolationLevel(isolation)
        .execute(async (trx) => {
          await effect(trx, 'isolation-before');
          try {
            await bus.publish(trx, {
              eventId: randomUUID(),
              appId: 'couli',
              name: 'order.created',
              payload: { order_id: 'guard-2' },
            });
          } catch (error) {
            failure = error;
          }
          // 拒绝本次发布不应靠破坏调用方事务来抹去写入。
          await effect(trx, 'isolation-after');
        });

      expect(eventErrorProblems(failure, 'invalid_transaction')).toStrictEqual([]);
      expect(await eventLog(observer)).toStrictEqual([]);
      expect(await evtJobs(observer)).toStrictEqual([]);
      expect(await effects(observer, 'isolation-before')).toBe(1);
      expect(await effects(observer, 'isolation-after')).toBe(1);
    } finally {
      await teardown([setup]);
      await closeObserver(observer);
      await database.drop();
    }
  },
  60_000,
);
