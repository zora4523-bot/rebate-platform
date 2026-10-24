// B2-15d restart rule test (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-05 (关单与过期任务持久化，
// 进程重启后继续), BR-PAY-02 (PO3); task §9.1 (order.close 由 B2-15b 的 cancel 入队), §9.3 (任务持久化在
// pg-boss，进程重启后由 worker 继续), §9.7 (重启模拟：任务在队列中、处理器重新注册后继续).
// The cancel goes through the real api entry, whose job queue writes the close job to pgboss and
// stops with it; then a fresh worker job queue on the same database registers the pay queue's
// handler (createPayJobHandler, as the worker entry registers it) and is started. pg-boss is real
// and polls in real time, so the wait is bounded and ends in an assertion.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { fixture, payOrder, success, suite, withHttp } from '../orders/kit.ts';
import { seedPending } from '../result/kit.ts';
import { closeChannels, closeJobs, until, withWorker } from './kit.ts';

const s = suite();

it('[AC-B2-15d#16] 关单任务持久化：用户取消入队的 order.close 在进程停掉后仍在 pgboss；重启后的 worker 重新注册处理器即把它执行完——先查后关、CLOSED，任务完成、不留待执行的关单任务', async () => {
  const f = await fixture(s);
  const channels = closeChannels(f);
  const order = await seedPending(f, 'wechat_pay');
  channels.wechat_pay.script(order, 'not_paid');
  await withHttp(f, async (send) => {
    f.clock.advanceMs(60_000);
    await success(await send('cancel', { id: order.id }));
  });
  // The api process is gone; the job is only in the database.
  const queued = await closeJobs(f, order);
  expect(queued.map((job) => [job.state, job.singleton_key])).toEqual([
    ['created', `order.close:${order.id}`],
  ]);

  await withWorker(f, channels, async () => {
    expect(
      await until(async () => (await payOrder(f, order.id)).status === 'CLOSED'),
      'the restarted worker closed the order',
    ).toBe(true);
  });
  expect(await payOrder(f, order.id)).toMatchObject({
    status: 'CLOSED',
    close_reason: 'user_cancel',
    closed_at: f.clock.now(),
    needs_manual: false,
  });
  const ops = channels.wechat_pay.opsOf(order);
  expect(ops[0]).toBe('query');
  expect(ops).toContain('close');
  expect((await closeJobs(f, order)).map((job) => job.state)).toEqual(['completed']);
}, 120_000);
