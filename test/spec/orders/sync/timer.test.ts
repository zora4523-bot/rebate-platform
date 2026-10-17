import { afterEach, expect, it, vi } from 'vitest';
import { createOrderSyncScheduler } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import { fixture } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  { configured: undefined, seconds: 60 },
  { configured: 120, seconds: 120 },
])(
  '[AC-B1-08g#24] 启动零投递，按配置或默认 $seconds 秒首次调度，停止后不再调度',
  async ({ configured, seconds }) => {
    vi.useFakeTimers();
    const f = fixture();
    const get = vi.fn(async () => configured);
    const scheduler = createOrderSyncScheduler(f.scheduler, { get });
    expect(f.send).not.toHaveBeenCalled();
    const loop = scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(f.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(get).toHaveBeenCalledWith('order_sync.pdd.interval_seconds');
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await loop.stop();
    }
    await vi.advanceTimersByTimeAsync(seconds * 3000);
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);
