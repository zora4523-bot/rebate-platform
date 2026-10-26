import { afterEach, expect, it, vi } from 'vitest';
import { capture } from '../attribution/kit.ts';
import { built } from '../wiring/db-kit.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';
import { ordersTimers } from '../wiring/owner-kit.ts';

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
  // D10-363：装配里别的模块（如 B2-15m payment 每 5 分钟查 pay_orders / pay_anomalies）也起定时器、
  // 发查询；停止后只看 orders 的查询（start() 之后在 orders 名下发出的，owner-kit.ts）。
  const t = ordersTimers();
  const f = await built(() => contextOf('worker', true));
  try {
    const r = await runtime(f.context);
    expect(f.queries).toEqual([]);
    expect(f.queue.send).not.toHaveBeenCalled();
    await f.queue.start();
    const ours = t.watch(f.queries);
    const running = await built(() => t.run(() => r.start()));
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
      await t.run(() => running.stop());
    }
    const queries = ours();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(ours()).toEqual(queries);
    expect(f.queue.send).not.toHaveBeenCalled();
  } finally {
    t.restore();
    await f.context.close();
  }
});
