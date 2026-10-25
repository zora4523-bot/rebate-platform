// B1-01zzo brief B.1: platform/metrics exports cacheFundCollector(collect, clock, ttlMs = 300_000).
// Within the TTL of the last successful collection it returns that same snapshot object; expired or
// never collected, it calls `collect`. A rejection is passed on, never cached and never replaced by
// an older snapshot (the next call collects again). Concurrent calls without a fresh snapshot share
// one collection in flight. Time is read from the injected Clock only. The snapshot itself is
// passed through unchanged, so createMetricsRegistry renders the same values ([AC-B1-01zzi#3]:
// the registry still calls collectFund on every render). Whether an age of exactly ttlMs is still
// fresh is not fixed here: the tests stay one millisecond either side of it.
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  cacheFundCollector,
  createMetricsRegistry,
  type FundMetricsSnapshot,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { fundFromText } from '../fund-metrics/kit.ts';
import { FIRST, NOW, NOW_MS, SECOND, TTL_MS, WORKER, deferred, settle, snapshotNo } from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-01zzo#1] 默认 TTL 5 分钟：创建时不采集；TTL 内返回上次成功的同一快照、底层只调一次；299 999 ms 仍用缓存，300 001 ms 重新采集，新快照另起 5 分钟', async () => {
  const clock = new FixedClock(NOW);
  const collect = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collect.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const cached = cacheFundCollector(collect, clock);
  expect(collect, 'nothing is collected before the first call').not.toHaveBeenCalled();

  expect(await cached()).toBe(FIRST);
  expect(await cached()).toBe(FIRST);
  clock.advanceMs(TTL_MS - 1);
  expect(await cached()).toBe(FIRST);
  expect(collect).toHaveBeenCalledTimes(1);

  clock.advanceMs(2);
  expect(await cached()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(2);
  // The new snapshot is fresh for its own 5 minutes, counted from its collection.
  clock.advanceMs(TTL_MS - 1);
  expect(await cached()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(2);
});

it('[AC-B1-01zzo#2] ttlMs 可传：1 000 ms 时 999 ms 仍用缓存、1 001 ms 重新采集；1 小时则过 5 分钟仍用缓存', async () => {
  const clock = new FixedClock(NOW);
  const collect = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collect.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const short = cacheFundCollector(collect, clock, 1_000);
  expect(await short()).toBe(FIRST);
  clock.advanceMs(999);
  expect(await short()).toBe(FIRST);
  expect(collect).toHaveBeenCalledTimes(1);
  clock.advanceMs(2);
  expect(await short()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(2);

  const longClock = new FixedClock(NOW);
  const longCollect = vi.fn<() => Promise<FundMetricsSnapshot>>();
  longCollect.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const long = cacheFundCollector(longCollect, longClock, 3_600_000);
  expect(await long()).toBe(FIRST);
  longClock.advanceMs(TTL_MS + 1);
  expect(await long()).toBe(FIRST);
  longClock.advanceMs(3_600_000 - TTL_MS - 2);
  expect(await long()).toBe(FIRST);
  expect(longCollect).toHaveBeenCalledTimes(1);
  longClock.advanceMs(2);
  expect(await long()).toBe(SECOND);
  expect(longCollect).toHaveBeenCalledTimes(2);
});

it('[AC-B1-01zzo#3] 采集失败不缓存、不回退旧值：拒绝原样传出，下一次（同一时刻）再调底层；过期后底层拒绝也不返回过期快照', async () => {
  const clock = new FixedClock(NOW);
  const down = new Error('fund port down');
  const downAgain = new Error('fund port down again');
  const collect = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collect
    .mockRejectedValueOnce(down)
    .mockResolvedValueOnce(FIRST)
    .mockRejectedValueOnce(downAgain)
    .mockResolvedValueOnce(SECOND);
  const cached = cacheFundCollector(collect, clock);

  // Nothing cached yet: the rejection comes through and is not remembered.
  await expect(cached()).rejects.toBe(down);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(await cached()).toBe(FIRST);
  expect(collect).toHaveBeenCalledTimes(2);

  // Expired: the rejection comes through instead of the old snapshot.
  clock.advanceMs(TTL_MS + 1);
  await expect(cached()).rejects.toBe(downAgain);
  expect(collect).toHaveBeenCalledTimes(3);
  // Still not cached: at the same instant the next call collects again, then caches that.
  expect(await cached()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(4);
  expect(await cached()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(4);
});

it('[AC-B1-01zzo#4] 无可用缓存时并发调用共享进行中的一次采集：首次与过期后各只调一次底层、都拿到同一快照；共享的采集失败则都拒绝且不缓存', async () => {
  const clock = new FixedClock(NOW);
  const first = deferred<FundMetricsSnapshot>();
  const collect = vi.fn<() => Promise<FundMetricsSnapshot>>(() => first.promise);
  const cached = cacheFundCollector(collect, clock);

  const a = cached();
  const b = cached();
  expect(collect).toHaveBeenCalledTimes(1);
  first.resolve(FIRST);
  expect(await a).toBe(FIRST);
  expect(await b).toBe(FIRST);
  expect(await cached()).toBe(FIRST);
  expect(collect).toHaveBeenCalledTimes(1);

  // Expired: two concurrent scrapes again cost one collection.
  clock.advanceMs(TTL_MS + 1);
  const second = deferred<FundMetricsSnapshot>();
  collect.mockImplementation(() => second.promise);
  const c = cached();
  const d = cached();
  expect(collect).toHaveBeenCalledTimes(2);
  second.resolve(SECOND);
  expect(await c).toBe(SECOND);
  expect(await d).toBe(SECOND);

  // A shared collection that rejects rejects every waiting caller and is not cached.
  clock.advanceMs(TTL_MS + 1);
  const third = deferred<FundMetricsSnapshot>();
  collect.mockImplementation(() => third.promise);
  const e = settle(cached());
  const g = settle(cached());
  expect(collect).toHaveBeenCalledTimes(3);
  const down = new Error('fund port down');
  third.reject(down);
  expect(await e).toEqual({ ok: false, error: down });
  expect(await g).toEqual({ ok: false, error: down });
  const fresh = snapshotNo(4);
  collect.mockImplementation(async () => fresh);
  expect(await cached()).toBe(fresh);
  expect(collect).toHaveBeenCalledTimes(4);
});

it('[AC-B1-01zzo#5] 时间只取注入的 Clock：系统时间前跳一天不使缓存过期；注入时钟走过 5 分钟（系统时间不动）才重新采集', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  const clock = new FixedClock(NOW);
  const now = vi.spyOn(clock, 'now');
  const collect = vi.fn<() => Promise<FundMetricsSnapshot>>();
  collect.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const cached = cacheFundCollector(collect, clock);

  expect(await cached()).toBe(FIRST);
  // The wall clock jumps a day ahead; the injected clock did not move.
  vi.setSystemTime(NOW_MS + 86_400_000);
  expect(await cached()).toBe(FIRST);
  expect(collect).toHaveBeenCalledTimes(1);

  // The wall clock is back where it started; the injected clock moves past the TTL.
  vi.setSystemTime(NOW_MS);
  clock.advanceMs(TTL_MS + 1);
  expect(await cached()).toBe(SECOND);
  expect(collect).toHaveBeenCalledTimes(2);
  expect(now).toHaveBeenCalled();
});

it('[AC-B1-01zzo#6] 任意顺序的时钟推进与成功 / 失败采集（逐次等待）：每次至多调一次底层；有效缓存内不调、无缓存或过期必调；结果是本次采集的快照或拒绝，或缓存的同一快照', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 10_000 }),
      fc.array(fc.record({ advance: fc.integer({ min: 0, max: 20_000 }), ok: fc.boolean() }), {
        minLength: 1,
        maxLength: 25,
      }),
      async (ttl, steps) => {
        const clock = new FixedClock(NOW);
        // What the stand-in collection did last; it succeeds or fails as the current step says.
        const last: {
          calls: number;
          ok: boolean;
          produced: FundMetricsSnapshot | undefined;
          failure: Error | undefined;
        } = { calls: 0, ok: true, produced: undefined, failure: undefined };
        const collect = async (): Promise<FundMetricsSnapshot> => {
          last.calls += 1;
          if (!last.ok) {
            const failure = new Error(`collection ${last.calls} failed`);
            last.failure = failure;
            throw failure;
          }
          const produced = snapshotNo(last.calls);
          last.produced = produced;
          return produced;
        };
        const cached = cacheFundCollector(collect, clock, ttl);
        // The model: the last successful snapshot and the instant it was collected.
        let model: { value: FundMetricsSnapshot; at: number } | undefined;
        for (const step of steps) {
          clock.advanceMs(step.advance);
          last.ok = step.ok;
          const before = last.calls;
          const result = await settle(cached());
          const called = last.calls - before;
          const at = clock.now().getTime();
          expect(called, 'at most one collection per call').toBeLessThanOrEqual(1);
          if (model !== undefined && at - model.at < ttl) expect(called, 'fresh').toBe(0);
          if (model === undefined || at - model.at > ttl) expect(called, 'stale').toBe(1);
          if (called === 0) {
            expect(model, 'a cached answer needs a cached snapshot').toBeDefined();
            expect(result.ok).toBe(true);
            if (result.ok && model !== undefined) expect(result.value).toBe(model.value);
          } else if (step.ok) {
            expect(result.ok).toBe(true);
            expect(last.produced).toBeDefined();
            if (result.ok) expect(result.value).toBe(last.produced);
            if (last.produced !== undefined) model = { value: last.produced, at };
          } else {
            expect(result).toEqual({ ok: false, error: last.failure });
            // Not cached; an older snapshot (expired here) is never served again.
            model = undefined;
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});

it('[AC-B1-01zzo#7] 交给 worker registry：每次 render 照旧调用 collectFund，但 5 分钟内两次 render 只调一次底层、资金值与快照一致（口径不变）；B1-01zzh 的 collect 每次都调；过期后底层失败则该次 render 失败', async () => {
  const clock = new FixedClock(NOW);
  const underlying = vi.fn<() => Promise<FundMetricsSnapshot>>();
  underlying.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);
  const collectFund = vi.fn(cacheFundCollector(underlying, clock));
  const collect = vi.fn(async () => WORKER);
  const registry = createMetricsRegistry({ entry: 'worker', collect, collectFund });

  const first = await registry.render();
  const second = await registry.render();
  expect(collectFund, 'the registry asks on every render').toHaveBeenCalledTimes(2);
  expect(collect, 'B1-01zzh collect is not cached').toHaveBeenCalledTimes(2);
  expect(underlying, 'one fund collection for both renders').toHaveBeenCalledTimes(1);
  expect(fundFromText(first)).toEqual(FIRST);
  expect(fundFromText(second)).toEqual(FIRST);

  clock.advanceMs(TTL_MS + 1);
  const third = await registry.render();
  expect(underlying).toHaveBeenCalledTimes(2);
  expect(fundFromText(third)).toEqual(SECOND);

  // Expired and failing: the scrape fails visibly rather than showing the old values.
  clock.advanceMs(TTL_MS + 1);
  const down = new Error('fund port down');
  underlying.mockRejectedValueOnce(down);
  await expect(registry.render()).rejects.toBe(down);
  underlying.mockResolvedValueOnce(FIRST);
  expect(fundFromText(await registry.render())).toEqual(FIRST);
  expect(underlying).toHaveBeenCalledTimes(4);
});
