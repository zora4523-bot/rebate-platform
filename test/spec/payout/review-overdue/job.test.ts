// B2-05n: the payout-overdue chain without a database (task brief §9.2 2: queue payout-overdue, job
// check, payload { slot }; the handler runs the check at clock.now(), then enqueues the next slot —
// trx null, singletonKey and delaySeconds of nextReviewOverdueSlot; seedReviewOverdue sends the
// slot the clock is in, without a delay, and a heal of the same slot sends the same key, which the
// exclusive queue merges). The check is a stub here; its behaviour is in the .int tests.
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { expect, it, vi } from 'vitest';
import {
  createReviewOverdueJob,
  seedReviewOverdue,
  type ReviewOverdueCheck,
} from '../../../../apps/api/src/modules/payout/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  NEXT_DELAY,
  NEXT_SLOT,
  NOW,
  SLOT,
  checkJob,
  fakeQueue,
  memoryLogger,
  overdueSends,
  rejection,
  slotSend,
  type FakeQueue,
} from './kit.ts';

/** A check that records the instants it ran at and how many sends had happened by then. */
function stubCheck(queue: FakeQueue, fail?: Error) {
  const runs: { now: string; sentBefore: number }[] = [];
  const check: ReviewOverdueCheck = {
    run: vi.fn(async (now: Date) => {
      runs.push({ now: now.toISOString(), sentBefore: queue.sent.length });
      if (fail !== undefined) throw fail;
      return { scanned: 0, judged: 0 };
    }),
  };
  return { check, runs };
}

it('[B2-05n 链] check 任务：按 clock.now() 运行一次检查，之后（不在事务里）入队下一槽：payout-overdue / check / { slot }，singletonKey 为下一槽键，延迟到下一槽到期', async () => {
  const queue = fakeQueue();
  const clock = new FixedClock(NOW);
  const { logger } = memoryLogger();
  const { check, runs } = stubCheck(queue);
  const handler = createReviewOverdueJob({ check, queue, clock, logger });
  await handler(checkJob(SLOT));
  expect(runs).toStrictEqual([{ now: NOW.toISOString(), sentBefore: 0 }]);
  expect(overdueSends(queue)).toStrictEqual([slotSend(NEXT_SLOT, NEXT_DELAY)]);
  expect(queue.sent).toHaveLength(1);
});

it('[B2-05n 链] check 任务的时刻取注入时钟而不是负载里的槽：晚到或重投的旧槽按当前时刻检查并接上当前时刻的下一槽；整 5 分钟边界延迟 300 秒', async () => {
  const queue = fakeQueue();
  const clock = new FixedClock('2032-10-21T02:20:00.000Z');
  const { logger } = memoryLogger();
  const { check, runs } = stubCheck(queue);
  const handler = createReviewOverdueJob({ check, queue, clock, logger });
  // A job of the 02:05 slot delivered at 02:20 (a retry, a late worker).
  await handler(checkJob(SLOT, 3));
  expect(runs).toStrictEqual([{ now: '2032-10-21T02:20:00.000Z', sentBefore: 0 }]);
  expect(overdueSends(queue)).toStrictEqual([slotSend('review-overdue:2032-10-21T02:25', 300)]);
});

it('[B2-05n 链] 检查失败时任务失败（拒绝，交队列重试），错误原样抛出', async () => {
  const queue = fakeQueue();
  const clock = new FixedClock(NOW);
  const { logger } = memoryLogger();
  const failure = new Error('synthetic check failure');
  const { check, runs } = stubCheck(queue, failure);
  const handler = createReviewOverdueJob({ check, queue, clock, logger });
  const error = await rejection(handler(checkJob(SLOT)));
  expect(error).toBe(failure);
  expect(runs).toHaveLength(1);
});

it('[B2-05n 种子] seedReviewOverdue：入队时钟所在的当前槽（不带延迟、不在事务里），不运行检查；同一槽再种（修复）用同一 singletonKey（exclusive 合并，不重复），进入下一槽后种新槽', async () => {
  const queue = fakeQueue();
  const clock = new FixedClock(NOW);
  const { logger } = memoryLogger();
  await seedReviewOverdue({ queue, clock, logger });
  expect(overdueSends(queue)).toStrictEqual([slotSend(SLOT)]);

  clock.set('2032-10-21T02:09:59.999Z');
  await seedReviewOverdue({ queue, clock, logger });
  expect(overdueSends(queue)).toStrictEqual([slotSend(SLOT), slotSend(SLOT)]);

  clock.set('2032-10-21T02:10:00.000Z');
  await seedReviewOverdue({ queue, clock, logger });
  expect(overdueSends(queue)).toStrictEqual([slotSend(SLOT), slotSend(SLOT), slotSend(NEXT_SLOT)]);
  expect(queue.sent).toHaveLength(3);
});

it('[B2-05n 链] 种子与任务接得上：种子送的当前槽任务被执行后，入队的正是下一槽；下一槽执行后再入队其后一槽（每槽一个键，键各不相同）', async () => {
  const queue = fakeQueue();
  const clock = new FixedClock(NOW);
  const { logger } = memoryLogger();
  const { check } = stubCheck(queue);
  const handler = createReviewOverdueJob({ check, queue, clock, logger });
  await seedReviewOverdue({ queue, clock, logger });
  await handler(checkJob(SLOT));
  clock.set('2032-10-21T02:10:00.250Z');
  await handler(checkJob(NEXT_SLOT));
  expect(overdueSends(queue)).toStrictEqual([
    slotSend(SLOT),
    slotSend(NEXT_SLOT, NEXT_DELAY),
    slotSend('review-overdue:2032-10-21T02:15', 300),
  ]);
});
