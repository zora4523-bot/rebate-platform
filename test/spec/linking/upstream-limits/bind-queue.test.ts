import { expect, it, vi } from 'vitest';
import {
  createBoundedQueue,
  getBindingAdmission,
} from '../../../../apps/api/src/modules/linking/application/upstream-limits.ts';
import { outcome } from '../open-pdd-auth/kit.ts';

it('[AC-B1-06za#2] 进程共用 bind 上限为 4/16/2000，排队不占在途名额', async () => {
  const gate = getBindingAdmission();
  expect(getBindingAdmission()).toBe(gate);
  expect([gate.concurrency, gate.queueCapacity, gate.waitMs]).toEqual([4, 16, 2000]);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let starts = 0;
  const work = vi.fn(async () => {
    starts += 1;
    if (starts === 4) entered.resolve();
    await release.promise;
    return 'synthetic-complete';
  });
  const running = Array.from({ length: 4 }, () => gate.run(work));
  await Promise.race([entered.promise, ...running]);
  const waiting = Array.from({ length: 16 }, () => gate.run(work));
  const excess = vi.fn(async () => 'must not run');
  try {
    expect([gate.running, gate.waiting]).toEqual([4, 16]);
    expect(work).toHaveBeenCalledTimes(4);
    expect(await gate.run(excess)).toEqual({ kind: 'full' });
    expect(excess).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.all([...running, ...waiting]);
  }
  expect(work).toHaveBeenCalledTimes(20);
  expect([gate.running, gate.waiting]).toEqual([0, 0]);
}, 10_000);

it('[AC-B1-06za#3] 排队按到达顺序交接，后来的提交不能抢先', async () => {
  const gate = createBoundedQueue({ concurrency: 1, queueCapacity: 2, waitMs: 2000 });
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const order: string[] = [];
  const a = gate.run(async () => {
    order.push('a');
    await first.promise;
  });
  const b = gate.run(async () => {
    order.push('b');
    secondEntered.resolve();
    await second.promise;
  });
  const c = gate.run(async () => {
    order.push('c');
  });
  const pending = [a, b, c];
  try {
    expect(
      await gate.run(async () => {
        order.push('overflow');
      }),
    ).toEqual({ kind: 'full' });
    first.resolve();
    await Promise.race([secondEntered.promise, b]);
    expect(order).toEqual(['a', 'b']);
    const d = gate.run(async () => {
      order.push('d');
    });
    pending.push(d);
    expect([gate.running, gate.waiting]).toEqual([1, 2]);
    second.resolve();
    await Promise.all(pending);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  } finally {
    first.resolve();
    second.resolve();
    await Promise.all(pending);
  }
}, 10_000);

it('[AC-B1-06za#4] 等待 1999ms 不超时，2000ms 超时并腾出队列，过期工作永不启动', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const release = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  try {
    const gate = createBoundedQueue({ concurrency: 1, queueCapacity: 1, waitMs: 2000 });
    pending.push(
      gate.run(async () => {
        await release.promise;
      }),
    );
    const expiredWork = vi.fn(async () => 'expired');
    let settled = false;
    const expired = gate.run(expiredWork).then((value) => {
      settled = true;
      return value;
    });
    pending.push(expired);
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    expect(gate.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await expired).toEqual({ kind: 'timeout' });
    expect([gate.running, gate.waiting]).toEqual([1, 0]);
    const replacement = vi.fn(async () => 'replacement');
    const next = gate.run(replacement);
    pending.push(next);
    expect(gate.waiting).toBe(1);
    release.resolve();
    expect(await next).toEqual({ kind: 'completed', value: 'replacement' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(expiredWork).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect([gate.running, gate.waiting]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    vi.useRealTimers();
  }
}, 10_000);

it.each(['sync', 'async'] as const)(
  '[AC-B1-06za#5] 工作 %s 抛错后交接名额，已入场者的等待计时器清理',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const release = Promise.withResolvers<void>();
    try {
      const gate = createBoundedQueue({ concurrency: 1, queueCapacity: 1, waitMs: 2000 });
      const failure = new Error('synthetic exchange failure');
      const failed = outcome(() =>
        gate.run(() => {
          if (kind === 'sync') throw failure;
          return Promise.reject(failure);
        }),
      );
      expect(await failed).toEqual({ thrown: failure });
      const entered = Promise.withResolvers<void>();
      const next = gate.run(async () => {
        entered.resolve();
        await release.promise;
        return 7;
      });
      await Promise.race([entered.promise, next]);
      await vi.advanceTimersByTimeAsync(2000);
      expect([gate.running, gate.waiting]).toEqual([1, 0]);
      release.resolve();
      expect(await next).toEqual({ kind: 'completed', value: 7 });
      expect([gate.running, gate.waiting]).toEqual([0, 0]);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  },
  10_000,
);
