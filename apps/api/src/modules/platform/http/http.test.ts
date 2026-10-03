import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createGovernor,
  createMemoryQuotaLimiter,
  quotaShares,
  systemScheduler,
  unionPolicy,
} from './index.ts';
import type { Scheduler } from './index.ts';

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
