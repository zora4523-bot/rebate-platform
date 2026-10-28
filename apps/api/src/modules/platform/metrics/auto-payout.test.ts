// Unit tests of the auto-payout collection cache (B1-01zzp): 5-minute reuse that also ends with the
// +08:00 day, never serving a rejected collection.
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { cacheAutoPayoutCollector, type AutoPayoutDailySnapshot } from './auto-payout.ts';

const A: AutoPayoutDailySnapshot = { totalFen: { a: 100 }, capFen: { a: 200 } };
const B: AutoPayoutDailySnapshot = { totalFen: { a: 0 }, capFen: { a: 200 } };

it('[AC-B1-01zzp#u1] 5 分钟内复用上次快照，满 5 分钟重新采集', async () => {
  const clock = new FixedClock('2031-04-06T02:00:00.000Z');
  const collect = vi.fn<() => Promise<AutoPayoutDailySnapshot>>();
  collect.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
  const cached = cacheAutoPayoutCollector(collect, clock);
  expect(await cached()).toBe(A);
  clock.advanceMs(299_999);
  expect(await cached()).toBe(A);
  clock.advanceMs(1);
  expect(await cached()).toBe(B);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B1-01zzp#u2] 跨过 +08:00 零点即重新采集，不沿用前一日合计', async () => {
  // 23:59:59.000 at +08:00, then one second later: the next +08:00 day, well within 5 minutes.
  const clock = new FixedClock('2031-04-05T15:59:59.000Z');
  const collect = vi.fn<() => Promise<AutoPayoutDailySnapshot>>();
  collect.mockResolvedValueOnce(A).mockResolvedValueOnce(B);
  const cached = cacheAutoPayoutCollector(collect, clock);
  expect(await cached()).toBe(A);
  clock.advanceMs(1_000);
  expect(await cached()).toBe(B);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B1-01zzp#u3] 采集失败不缓存：下一次调用重新采集', async () => {
  const clock = new FixedClock('2031-04-06T02:00:00.000Z');
  const failure = new Error('read failed');
  const collect = vi.fn<() => Promise<AutoPayoutDailySnapshot>>();
  collect.mockRejectedValueOnce(failure).mockResolvedValueOnce(A);
  const cached = cacheAutoPayoutCollector(collect, clock);
  await expect(cached()).rejects.toBe(failure);
  expect(await cached()).toBe(A);
  expect(collect).toHaveBeenCalledTimes(2);
});
