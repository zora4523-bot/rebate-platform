import { afterEach, expect, it, vi } from 'vitest';
import { capture } from '../attribution/kit.ts';
import { built } from '../wiring/db-kit.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-08w#3] 生产处理器识别 snapshot-retry 并查询待处理订单', async () => {
  const f = await built(() => contextOf('worker', true));
  try {
    await runtime(f.context);
    const registrations = f.queue.register.mock.calls.filter(([name]) => name === 'order-sync');
    expect(registrations).toHaveLength(1);
    const result = await capture(() =>
      registrations[0]![1]({
        id: 'synthetic-retry',
        queue: 'order-sync',
        name: 'snapshot-retry',
        payload: { app_id: 'synthetic-app' },
        attempt: 1,
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(f.queries.some((q) => q.includes('order_sync_pending'))).toBe(true);
  } finally {
    await f.context.close();
  }
});

it('[AC-B1-08w#4] 生产补偿调度满十五分钟才扫描，停止后不再扫描或投递', async () => {
  vi.useFakeTimers();
  const f = await built(() => contextOf('worker', true));
  try {
    const r = await runtime(f.context);
    expect(f.queries).toEqual([]);
    expect(f.queue.send).not.toHaveBeenCalled();
    await f.queue.start();
    const running = await built(() => r.start());
    try {
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
      expect(f.queries.filter((q) => q.includes('order_sync_pending'))).toEqual([]);
      expect(f.queue.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.queries.filter((q) => q.includes('order_sync_pending'))).toEqual([
        expect.stringContaining('"app_id"'),
      ]);
      expect(f.queue.send).not.toHaveBeenCalled();
    } finally {
      await running.stop();
    }
    const queries = [...f.queries];
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.queries).toEqual(queries);
    expect(f.queue.send).not.toHaveBeenCalled();
  } finally {
    await f.context.close();
  }
});
