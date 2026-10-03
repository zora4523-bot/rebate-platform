import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createGovernor,
  createMemoryQuotaLimiter,
  quotaShares,
  systemScheduler,
  unionPolicy,
} from './index.ts';
import type { QuotaPurpose, Scheduler } from './index.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-01b#1] 调度器取消等待、拒绝已取消信号，并在正常完成时移除监听器', async () => {
  const scheduler = systemScheduler();
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const waiting = scheduler.sleep(100, controller.signal);
  const cancelled = expect(waiting).rejects.toBe(reason);
  controller.abort(reason);
  await cancelled;
  await expect(scheduler.sleep(100, controller.signal)).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);

  const normal = new AbortController();
  const remove = vi.spyOn(normal.signal, 'removeEventListener');
  const started = scheduler.now();
  const completed = scheduler.sleep(100, normal.signal);
  await vi.advanceTimersByTimeAsync(100);
  await expect(completed).resolves.toBeUndefined();
  expect(scheduler.now() - started).toBe(100);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#2] 超长等待不会被 Node 截成一毫秒', async () => {
  const scheduler = systemScheduler();
  const done = vi.fn();
  const waiting = scheduler.sleep(2_147_483_657).then(done);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(done).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10);
  await waiting;
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#3] 上游同步抛错保留原错误，写请求只调用一次并清理超时等待', async () => {
  const error = new Error('synchronous failure');
  const operation = vi.fn((): Promise<never> => {
    throw error;
  });
  const governor = createGovernor('test', unionPolicy('online'));
  await expect(governor.call(operation, { kind: 'write' })).rejects.toBe(error);
  expect(operation).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#4] 上游在 abort 中返回成功也不能改变超时结果', async () => {
  const governor = createGovernor('test', unionPolicy('online'));
  const classify = vi.fn(() => 'rejected' as const);
  const call = governor.call(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => resolve('too late'), { once: true });
      }),
    { kind: 'write', classify },
  );
  const result = expect(call).rejects.toMatchObject({ code: 'timeout', dependency: 'test' });
  await vi.advanceTimersByTimeAsync(3000);
  await result;
  expect(classify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#5] 超时后的迟到错误不重复计入熔断', async () => {
  const governor = createGovernor('test', {
    ...unionPolicy('online'),
    breaker: { windowMs: 10000, minRequests: 2, failureRatePercent: 50, openMs: 1000 },
  });
  let rejectLate: (error: Error) => void = () => {
    throw new Error('operation was not invoked');
  };
  const call = governor.call(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      }),
    { kind: 'write' },
  );
  const result = expect(call).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(3000);
  await result;
  rejectLate(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(1);
  await expect(governor.call(() => Promise.resolve('ok'), { kind: 'write' })).resolves.toBe('ok');
  expect(governor.breakerState()).toBe('closed');
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#6] 熔断期间已在途请求的失败不会延后恢复时间', async () => {
  const governor = createGovernor('test', {
    ...unionPolicy('online'),
    breaker: { windowMs: 10000, minRequests: 1, failureRatePercent: 50, openMs: 1000 },
  });
  let rejectPending: (error: Error) => void = () => {
    throw new Error('operation was not invoked');
  };
  const pending = governor.call(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectPending = reject;
      }),
    { kind: 'write' },
  );
  const error = new Error('down');
  const pendingResult = expect(pending).rejects.toBe(error);
  await expect(governor.call(() => Promise.reject(error), { kind: 'write' })).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(999);
  rejectPending(error);
  await pendingResult;
  expect(governor.breakerState()).toBe('open');
  await vi.advanceTimersByTimeAsync(1);
  expect(governor.breakerState()).toBe('closed');
  await expect(governor.call(() => Promise.resolve('ok'), { kind: 'write' })).resolves.toBe('ok');
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#7] 创建后改动输入策略不影响已校验的超时', async () => {
  const policy = { ...unionPolicy('online') };
  const governor = createGovernor('test', policy);
  policy.timeoutMs = 1;
  const operation = vi.fn(() => new Promise<never>(() => {}));
  const call = governor.call(operation, { kind: 'write' });
  const result = expect(call).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(2999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(operation).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#8] 配额快照隔离输入变更且整数容量不会因小数份额少算一个令牌', () => {
  const config = {
    bucketKey: 'test',
    capacity: 100,
    refillPerSecond: 10,
    shares: { ...quotaShares('mvp'), online: 61, order_sync: 29 },
  };
  const limiter = createMemoryQuotaLimiter(config);
  config.shares.order_sync = 0;
  config.capacity = 1;
  config.bucketKey = 'changed';
  const acquired = Array.from({ length: 30 }, () => limiter.tryAcquire('order_sync'));
  expect(acquired.filter(Boolean)).toHaveLength(29);
  expect(acquired[29]).toBe(false);
  expect(limiter.bucketKey).toBe('test');
});

it.each(['resolve', 'reject', 'throw'] as const)(
  '[AC-B1-01b#9] 定时器尚未触发时，上游 %s 在截止时刻前按原结果结束，到期及之后按超时结束',
  async (outcome) => {
    for (const elapsed of [9, 10, 30]) {
      let now = 100;
      const scheduler: Scheduler = { now: () => now, sleep: systemScheduler().sleep };
      const governor = createGovernor(
        'test',
        {
          ...unionPolicy('online'),
          timeoutMs: 10,
          breaker: { windowMs: 10000, minRequests: 1, failureRatePercent: 50, openMs: 1000 },
        },
        { scheduler },
      );
      let upstreamSignal: AbortSignal | undefined;
      const upstreamError = new Error('upstream');
      const classify = vi.fn(() => 'rejected' as const);
      const call = governor.call(
        (signal) => {
          upstreamSignal = signal;
          // Advance the injected clock without executing the pending timeout callback.
          now += elapsed;
          if (outcome === 'throw') throw upstreamError;
          return outcome === 'resolve' ? Promise.resolve('ok') : Promise.reject(upstreamError);
        },
        { kind: 'write', classify },
      );
      if (elapsed < 10) {
        if (outcome === 'resolve') await expect(call).resolves.toBe('ok');
        else await expect(call).rejects.toBe(upstreamError);
        expect(upstreamSignal?.aborted).toBe(false);
        expect(governor.breakerState()).toBe('closed');
      } else {
        await expect(call).rejects.toMatchObject({ code: 'timeout', dependency: 'test' });
        expect(upstreamSignal?.aborted).toBe(true);
        await expect(call).rejects.toBe(upstreamSignal?.reason);
        expect(governor.breakerState()).toBe('open');
        expect(classify).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  },
);

it.each([1000, 1, 7, 37])(
  '[AC-B1-01b#10] 29%% 配额耗尽后每隔 %i 毫秒尝试获取，整秒累计恰好回填 29 个令牌',
  (interval) => {
    let now = 0;
    const scheduler: Scheduler = { now: () => now, sleep: systemScheduler().sleep };
    const limiter = createMemoryQuotaLimiter(
      {
        bucketKey: 'test',
        capacity: 100,
        refillPerSecond: 100,
        shares: { online: 61, order_sync: 29, pool_refresh: 10, watch: 0 },
      },
      scheduler,
    );
    const drain = (): number =>
      Array.from({ length: 30 }, () => limiter.tryAcquire('order_sync')).filter(Boolean).length;
    expect(drain()).toBe(29);
    // Keep polling and consuming over multiple seconds, without letting the bucket fill.
    for (let second = 1; second <= 3; second += 1) {
      let acquired = 0;
      const boundary = second * 1000;
      while (now < boundary) {
        now = Math.min(boundary, now + interval);
        acquired += drain();
      }
      expect(acquired).toBe(29);
      expect(limiter.tryAcquire('order_sync')).toBe(false);
    }
    now += 3_600_000;
    expect(drain()).toBe(29);
    expect(limiter.tryAcquire('order_sync')).toBe(false);
    now += 1000;
    expect(drain()).toBe(29);
  },
);

it('[AC-B1-01b#11] 分类器抛错仍重试幂等读、保留上游错误，并在第 20 次失败后熔断', async () => {
  const upstreamError = new Error('upstream');
  const operation = vi.fn(() => Promise.reject(upstreamError));
  const classify = vi.fn(() => {
    throw new Error('classifier bug');
  });
  const governor = createGovernor('test', unionPolicy('online'));
  for (let callIndex = 0; callIndex < 25; callIndex += 1) {
    const call = governor.call(operation, { kind: 'idempotent_read', classify });
    const result =
      callIndex < 6
        ? expect(call).rejects.toBe(upstreamError)
        : expect(call).rejects.toMatchObject({ code: 'circuit_open' });
    await vi.advanceTimersByTimeAsync(600);
    await result;
    expect(operation).toHaveBeenCalledTimes(Math.min((callIndex + 1) * 3, 20));
    expect(governor.breakerState()).toBe(callIndex < 6 ? 'closed' : 'open');
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(classify).toHaveBeenCalledTimes(20);
});

it.each([-1, 0, -Infinity, NaN])(
  '[AC-B1-01b#12] sleep(%s) 在下一轮定时器执行时正常结束',
  async (duration) => {
    const done = vi.fn();
    const waiting = systemScheduler().sleep(duration).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('[AC-B1-01b#13] 无限等待不创建定时器，只在信号中止时以原原因拒绝并移除监听器', async () => {
  const scheduler = systemScheduler();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const done = vi.fn();
  const waiting = scheduler.sleep(Infinity, controller.signal);
  void waiting.then(done, done);
  void scheduler.sleep(Infinity).then(done);
  const reason = new Error('cancel infinite sleep');
  const result = expect(waiting).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(done).not.toHaveBeenCalled();
  controller.abort(reason);
  await result;
  expect(done).toHaveBeenCalledExactlyOnceWith(reason);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-01b#14] 76% 的每秒 3 个令牌在 25 秒回填恰好 57 个，并在最早整数毫秒取得第 58 个', () => {
  let now = 0;
  const limiter = createMemoryQuotaLimiter(
    {
      bucketKey: 'exact-refill',
      capacity: 100,
      refillPerSecond: 3,
      shares: { online: 24, order_sync: 76, pool_refresh: 0, watch: 0 },
    },
    { now: () => now, sleep: systemScheduler().sleep },
  );
  for (let token = 0; token < 76; token += 1) expect(limiter.tryAcquire('order_sync')).toBe(true);
  expect(limiter.tryAcquire('order_sync')).toBe(false);
  now = 25_000;
  for (let token = 0; token < 57; token += 1) expect(limiter.tryAcquire('order_sync')).toBe(true);
  expect(limiter.tryAcquire('order_sync')).toBe(false);
  now = Math.ceil((58 * 100_000) / 228) - 1;
  expect(limiter.tryAcquire('order_sync')).toBe(false);
  now += 1;
  expect(limiter.tryAcquire('order_sync')).toBe(true);
  expect(limiter.tryAcquire('order_sync')).toBe(false);
});

it('[AC-B1-01b#15] 70% 的每秒 3 个令牌在十秒回填 21 个，10% 的每秒 10 个令牌在轮询中保留余数', () => {
  let now = 0;
  const scheduler: Scheduler = { now: () => now, sleep: systemScheduler().sleep };
  const online = createMemoryQuotaLimiter(
    {
      bucketKey: 'online',
      capacity: 100,
      refillPerSecond: 3,
      shares: { online: 70, order_sync: 30, pool_refresh: 0, watch: 0 },
    },
    scheduler,
  );
  const pool = createMemoryQuotaLimiter(
    { bucketKey: 'pool', capacity: 100, refillPerSecond: 10, shares: quotaShares('mvp') },
    scheduler,
  );
  for (let token = 0; token < 70; token += 1) expect(online.tryAcquire('online')).toBe(true);
  for (let token = 0; token < 10; token += 1) expect(pool.tryAcquire('pool_refresh')).toBe(true);
  for (now = 100; now < 1000; now += 100) expect(pool.tryAcquire('pool_refresh')).toBe(false);
  expect(pool.tryAcquire('pool_refresh')).toBe(true);
  expect(pool.tryAcquire('pool_refresh')).toBe(false);
  now = 10_000;
  for (let token = 0; token < 21; token += 1) expect(online.tryAcquire('online')).toBe(true);
  expect(online.tryAcquire('online')).toBe(false);
});

it.each([
  { rate: 1e-7, boundary: 10_000_000_000, before: 1 },
  { rate: 2.5e-7, boundary: 4_000_000_000, before: 1 },
  { rate: 0.01, boundary: 100_000, before: 1 },
  { rate: 2000, boundary: 0.5, before: 0.1 },
  { rate: 10_000, boundary: 0.1, before: 0.01 },
  { rate: 10_000, boundary: 0.7, before: 0.01 },
  { rate: 1e21, boundary: 0.000001, before: 0.000001 },
])(
  '[AC-B1-01b#16] 速率 $rate 与小数毫秒边界 $boundary 保留精确回填且丢弃溢出',
  ({ rate, boundary, before }) => {
    let now = 0;
    const limiter = createMemoryQuotaLimiter(
      {
        bucketKey: 'decimal-refill',
        capacity: 10,
        refillPerSecond: rate,
        shares: { online: 100, order_sync: 0, pool_refresh: 0, watch: 0 },
      },
      { now: () => now, sleep: systemScheduler().sleep },
    );
    const drain = (): number =>
      Array.from({ length: 11 }, () => limiter.tryAcquire('online')).filter(Boolean).length;
    expect(drain()).toBe(10);
    now = boundary - before;
    const earlier = drain();
    now = boundary;
    // The 0.7 ms case has six tokens available just before its seventh token arrives.
    expect(earlier).toBe(boundary === 0.7 ? 6 : 0);
    expect(drain()).toBe(rate === 1e21 ? 10 : 1);
    now = boundary * 100;
    expect(drain()).toBe(10);
    expect(limiter.tryAcquire('online')).toBe(false);
  },
);

it('[AC-B1-01b#17] 固定种子 500 组配置、每组 60 次时刻推进及突发取用与独立 BigInt 余额模型一致', () => {
  const purposes: readonly QuotaPurpose[] = ['online', 'order_sync', 'pool_refresh', 'watch'];
  let seed = 0xb101b;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed % limit;
  };
  let borrowed = 0;
  for (let sample = 0; sample < 500; sample += 1) {
    const capacity = 1 + random(1000);
    const rateHundredths = sample % 2 === 0 ? (1 + random(1000)) * 100 : 100 + random(99_901);
    const online = random(101);
    const orderSync = random(101 - online);
    const poolRefresh = random(101 - online - orderSync);
    const shares = {
      online,
      order_sync: orderSync,
      pool_refresh: poolRefresh,
      watch: 100 - online - orderSync - poolRefresh,
    };
    let now = 0;
    const limiter = createMemoryQuotaLimiter(
      { bucketKey: `sample-${sample}`, capacity, refillPerSecond: rateHundredths / 100, shares },
      { now: () => now, sleep: systemScheduler().sleep },
    );
    // Independent incremental balance model: one token = 100 (rate hundredths) ×
    // 100 (share percent) × 1000 (milliseconds). Update every bucket at every call.
    const unit = 10_000_000n;
    const balances = purposes.map((purpose) => {
      const cap = ((BigInt(capacity) * BigInt(shares[purpose])) / 100n) * unit;
      return { cap, balance: cap, refill: BigInt(rateHundredths) * BigInt(shares[purpose]) };
    });
    let previous = 0;
    const modelTake = (purpose: QuotaPurpose): boolean => {
      const elapsed = BigInt(now - previous);
      previous = now;
      for (const bucket of balances) {
        bucket.balance += elapsed * bucket.refill;
        if (bucket.balance > bucket.cap) bucket.balance = bucket.cap;
      }
      const take = (target: QuotaPurpose): boolean => {
        const bucket = balances[purposes.indexOf(target)];
        if (bucket === undefined || bucket.balance < unit) return false;
        bucket.balance -= unit;
        return true;
      };
      if (take(purpose)) return true;
      if (purpose === 'online' && take('pool_refresh')) {
        borrowed += 1;
        return true;
      }
      return false;
    };
    const compare = (purpose: QuotaPurpose, count: number): void => {
      const expected = Array.from({ length: count }, () => modelTake(purpose));
      const actual = Array.from({ length: count }, () => limiter.tryAcquire(purpose));
      expect(actual, `sample=${sample}, now=${now}, purpose=${purpose}`).toEqual(expected);
    };
    // Exhaust all starting balances, including online borrowing pool-refresh tokens.
    for (const purpose of purposes) compare(purpose, capacity + 1);
    for (let step = 0; step < 60; step += 1) {
      now += step % 10 === 0 ? 0 : step % 10 === 1 ? 5000 : random(5001);
      const purpose = purposes[random(purposes.length)];
      if (purpose === undefined) throw new Error('Missing purpose');
      compare(purpose, 1 + random(20));
    }
  }
  expect(borrowed).toBeGreaterThan(0);
}, 30_000);

it.each([1e307, Number.MAX_SAFE_INTEGER, 2 ** 53])(
  '[AC-B1-01b#18] 容量 %s 的全额在线桶在固定时钟下连续取用 1000 次均成功',
  (capacity) => {
    const limiter = createMemoryQuotaLimiter(
      {
        bucketKey: 'large-capacity',
        capacity,
        refillPerSecond: 1,
        shares: { online: 100, order_sync: 0, pool_refresh: 0, watch: 0 },
      },
      { now: () => 0, sleep: systemScheduler().sleep },
    );
    for (let token = 0; token < 1000; token += 1) {
      expect(limiter.tryAcquire('online')).toBe(true);
    }
  },
);

it('[AC-B1-01b#19] 最大有限容量按 60/30/10/0 分桶后各连续取用 100 次，零份额始终拒绝', () => {
  const limiter = createMemoryQuotaLimiter(
    {
      bucketKey: 'maximum-capacity',
      capacity: Number.MAX_VALUE,
      refillPerSecond: 1,
      shares: quotaShares('mvp'),
    },
    { now: () => 0, sleep: systemScheduler().sleep },
  );
  const purposes: readonly QuotaPurpose[] = ['online', 'order_sync', 'pool_refresh', 'watch'];
  for (const purpose of purposes) {
    for (let token = 0; token < 100; token += 1) {
      expect(limiter.tryAcquire(purpose)).toBe(purpose !== 'watch');
    }
  }
});
