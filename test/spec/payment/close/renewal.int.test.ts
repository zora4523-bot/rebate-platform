// B2-15d renewal-across-restart rule test (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-05 ③ (过了
// expire_at 之后每 pay.close_retry_minutes 重做一次查询与关单), 关单与过期任务持久化、进程重启后继续;
// task §9.3 (任务自我续期：处理完仍 PENDING 则入队下一次，delaySeconds = retry 分钟；节奏点以 Clock
// 计算、任务持久化在 pg-boss), §9.7.
// The expire_at hand-over of B2-15c is enqueued on an api job queue that then stops; a worker job
// queue (createPayJobHandler, real pg-boss on the test database) runs it while the channel has no
// answer, and must leave the next run in pgboss (queue `pay` is exclusive per singletonKey: the
// next run has to be accepted while the current one is still active). That worker stops; the
// five minutes are not waited in real time (the job is made due), and a new worker continues.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { fixture, payOrder, suite } from '../orders/kit.ts';
import { seedPending } from '../result/kit.ts';
import {
  RETRY_SECONDS,
  closeChannels,
  closeJobs,
  closePayload,
  dueNow,
  enqueueAndStop,
  until,
  withWorker,
} from './kit.ts';

const s = suite();

it('[AC-B2-15d#17] 过期关单的自我续期也持久化：worker 执行到期关单、渠道无结果 → 下一次关单任务以 300 秒延迟写进 pgboss、本次任务完成；进程停掉，重启后的 worker 在它到期时继续执行，渠道已可关闭 → CLOSED，不再留关单任务', async () => {
  const f = await fixture(s);
  const channels = closeChannels(f);
  const order = await seedPending(f, 'alipay');
  channels.alipay.script(order, 'timeout');
  f.clock.set(order.expire_at);
  const first = await enqueueAndStop(
    f,
    'order.close',
    closePayload(order, 'expired'),
    `order.close:${order.id}`,
  );
  expect(first).not.toBeNull();

  await withWorker(f, channels, async () => {
    expect(
      await until(async () => {
        const jobs = await closeJobs(f, order);
        return jobs.length >= 2 && jobs[0]?.state === 'completed';
      }),
      'the first run completed and left its next run in pgboss',
    ).toBe(true);
  });
  const persisted = await closeJobs(f, order);
  expect(persisted.map((job) => job.state)).toEqual(['completed', 'created']);
  expect(Math.round(persisted[1]?.delay ?? 0)).toBe(RETRY_SECONDS);
  expect(persisted[1]?.singleton_key?.startsWith(`order.close:${order.id}`)).toBe(true);
  expect(await payOrder(f, order.id)).toMatchObject({
    status: 'PENDING',
    closing: true,
    close_reason: 'expired',
    needs_manual: false,
  });
  expect(channels.alipay.opsOf(order)).toContain('query');

  // Five minutes on: the channel can close it now; a new worker process picks the job up.
  f.clock.advanceMs(RETRY_SECONDS * 1000);
  channels.alipay.script(order, 'not_paid');
  await dueNow(f, persisted[1]!.id);
  await withWorker(f, channels, async () => {
    expect(
      await until(async () => (await payOrder(f, order.id)).status === 'CLOSED'),
      'the restarted worker continued the close flow',
    ).toBe(true);
  });
  expect(await payOrder(f, order.id)).toMatchObject({
    status: 'CLOSED',
    close_reason: 'expired',
    closed_at: f.clock.now(),
    needs_manual: false,
  });
  expect((await closeJobs(f, order)).map((job) => job.state)).toEqual(['completed', 'completed']);
}, 150_000);
