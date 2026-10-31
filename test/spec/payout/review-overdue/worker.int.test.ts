// B2-05n: the worker's assembly of the payout-overdue chain (task brief §9.2 3: payout.module
// forWorker registers the handler of queue payout-overdue over the entry's couli_app handle, event
// bus and identity's users lock that app.module hands in; a module timer seeds the current slot
// after bootstrap and heals it on an interval, as LedgerDailyCheckModule / the payout-recon chain do:
// first seed 15 s after bootstrap, then every 30 minutes). The options are the ones app.module
// really passes (captured); the module runs in a Nest application context with the platform
// tokens of the worker entry, a recording job queue and a real database.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { PayoutModule } from '../../../../apps/api/src/modules/payout/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  MINUTE,
  NEXT_DELAY,
  NEXT_SLOT,
  NOW,
  QUEUE,
  SLOT,
  TIMEOUT,
  WARN,
  appId,
  capturedWorkerOptions,
  checkJob,
  eventBus,
  eventsOf,
  expectedEvent,
  fakeQueue,
  overdueSends,
  rootLogger,
  seed,
  slotSend,
  stored,
  until,
  withHarness,
  workerContext,
  type NestContext,
} from './kit.ts';

it(
  '[B2-05n 装配] worker 入口：PayoutModule.forWorker 为 payout-overdue 恰注册一个处理器；处理一个 check 任务即用入口的 couli_app 句柄、事件总线与 identity 的行锁判定到期单（列、事件、pino warn withdrawal_review_overdue），并入队下一槽',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const clock = new FixedClock(NOW);
      const root = rootLogger();
      const options = await capturedWorkerOptions(clock, root.logger);
      const app = appId();
      const w = await seed(h.db, app);
      const queue = fakeQueue();
      let context: NestContext | undefined;
      try {
        context = await workerContext(PayoutModule.forWorker(options), {
          clock,
          logger: root.logger,
          db: h.db,
          queue,
          eventBus: eventBus(clock).bus,
        });
        const handlers = queue.registered.filter((item) => item.queue === QUEUE);
        expect(handlers, 'no handler registered for payout-overdue').toHaveLength(1);
        const handler = handlers[0]?.handler;
        expect(handler).toBeTypeOf('function');
        await handler?.(checkJob(SLOT));

        expect((await stored(h.observer, w)).reviewOverdueAt).toBe(NOW.toISOString());
        expect(await eventsOf(h.observer, w)).toStrictEqual([expectedEvent(w)]);
        const warns = root
          .lines()
          .filter((line) => line['level'] === 40 && (line['msg'] ?? line['message']) === WARN);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toEqual(
          expect.objectContaining({
            app_id: w.appId,
            withdrawal_id: w.id,
            review_deadline: w.reviewDeadline?.toISOString(),
            overdue_at: NOW.toISOString(),
          }),
        );
        expect(overdueSends(queue)).toContainEqual(slotSend(NEXT_SLOT, NEXT_DELAY));
      } finally {
        await context?.close();
      }
    });
  },
  TIMEOUT,
);

it(
  '[B2-05n 种子 / 修复] worker 模块的定时器：启动后 1 分钟内种下当前槽（不带延迟、不在事务里），30 分钟内的修复再种修复时刻所在的槽（同槽同键，exclusive 合并）；模块销毁后不再发送',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const clock = new FixedClock(NOW);
      const root = rootLogger();
      const options = await capturedWorkerOptions(clock, root.logger);
      const queue = fakeQueue();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      let context: NestContext | undefined;
      try {
        context = await workerContext(PayoutModule.forWorker(options), {
          clock,
          logger: root.logger,
          db: h.db,
          queue,
          eventBus: eventBus(clock).bus,
        });
        await vi.advanceTimersByTimeAsync(MINUTE);
        const seeded = await until(() => overdueSends(queue).length > 0, 10_000);
        expect(seeded, 'no seed of payout-overdue within a minute of bootstrap').toBe(true);
        expect(overdueSends(queue)).toContainEqual(slotSend(SLOT));

        // Twenty minutes later (another slot): a heal within 30 minutes seeds that slot.
        const later = 'review-overdue:2032-10-21T02:25';
        clock.set(new Date(NOW.getTime() + 20 * MINUTE));
        await vi.advanceTimersByTimeAsync(30 * MINUTE);
        const healed = await until(
          () => overdueSends(queue).some((send) => send.singletonKey === later),
          10_000,
        );
        expect(healed, 'no heal within 30 minutes seeded the current slot').toBe(true);
        expect(overdueSends(queue)).toContainEqual(slotSend(later));
        // Every send of the timer is a seed: a current slot, its key as its payload, at once.
        for (const send of overdueSends(queue)) {
          expect([SLOT, later]).toContain(send.singletonKey);
          expect(send).toStrictEqual(slotSend(String(send.singletonKey)));
        }

        await context.close();
        context = undefined;
        const before = queue.sent.length;
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
        await until(() => false, 300);
        expect(queue.sent).toHaveLength(before);
      } finally {
        await context?.close();
        vi.useRealTimers();
      }
    });
  },
  TIMEOUT,
);
