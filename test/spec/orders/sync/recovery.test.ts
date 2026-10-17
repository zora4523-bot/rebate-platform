import { expect, it } from 'vitest';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import { handleOrderSyncWindow } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { END, START, fixture, job, order, window } from './kit.ts';

it('[AC-B1-08g#19] 页失败后重试沿用原起止，已处理子订单允许重新交幂等端口', async () => {
  const f = fixture();
  const failure = new Error('synthetic transient second page failure');
  const first = order('first');
  const second = order('second', '102');
  f.listOrders
    .mockResolvedValueOnce({ items: [first], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [second], nextCursor: null })
    .mockResolvedValueOnce({ items: [first], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [second], nextCursor: null });
  f.process
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  await expect(handleOrderSyncWindow(job(), f.handler)).rejects.toBe(failure);
  expect(f.advance).not.toHaveBeenCalled();
  f.clock.advanceMs(7_200_000);
  await handleOrderSyncWindow(job(window, 2), f.handler);
  expect(f.listOrders.mock.calls.map(([win]) => win)).toEqual(
    Array.from({ length: 4 }, () => ({ from: START, to: END })),
  );
  expect(f.process.mock.calls.map(([item]) => item.order_id)).toEqual([
    'first',
    'second',
    'first',
    'second',
  ]);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(window);
});

it('[AC-B1-08g#20] 重试耗尽不越过失败水位，下次定时调度重新投当前窗口', async () => {
  const f = fixture();
  const failure = new Error('synthetic upstream offline');
  f.read.mockResolvedValue(START);
  f.listOrders.mockRejectedValue(failure);
  // D10-29: initial execution + catalog default five retries; dead-letter is platform-owned.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await expect(handleOrderSyncWindow(job(window, attempt), f.handler)).rejects.toBe(failure);
  }
  expect(f.listOrders).toHaveBeenCalledTimes(6);
  expect(f.advance).not.toHaveBeenCalled();
  f.clock.advanceMs(86_400_000);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([window]);
});

it('[AC-B1-08g#21] 下个窗口只能在上窗推进后从新水位起算', async () => {
  const f = fixture();
  let cursor = START;
  f.read.mockImplementation(async () => cursor);
  f.advance.mockImplementation(async (w) => {
    cursor = w.window_end;
    return true;
  });
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([window]);
  await handleOrderSyncWindow(job(), f.handler);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([
    window,
    { ...window, window_start: END, window_end: '2026-10-17T01:00:00.000Z' },
  ]);
});
