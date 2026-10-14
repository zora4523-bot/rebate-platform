import { expect, it, vi } from 'vitest';
import { createBoundedQueue } from '../../../../apps/api/src/modules/linking/application/upstream-limits.ts';
import { outcome } from '../open-pdd-auth/kit.ts';

it('[AC-B1-06za#15] 在途工作抛错立即交接给已有队首，不等排队超时且不越过队首', async () => {
  vi.useFakeTimers();
  const fail = Promise.withResolvers<void>();
  const releaseHead = Promise.withResolvers<void>();
  const pending: Promise<unknown>[] = [];
  try {
    const gate = createBoundedQueue({ concurrency: 1, queueCapacity: 2, waitMs: 2000 });
    const entered = Promise.withResolvers<void>();
    const failure = new Error('synthetic exchange failure');
    const first = outcome(() =>
      gate.run(async () => {
        entered.resolve();
        await fail.promise;
        throw failure;
      }),
    );
    pending.push(first);
    await Promise.race([entered.promise, first]);
    expect(gate.running).toBe(1);

    const order: string[] = [];
    const headWork = vi.fn(async () => {
      order.push('head');
      await releaseHead.promise;
      return 'synthetic-head';
    });
    const tailWork = vi.fn(async () => {
      order.push('tail');
      return 'synthetic-tail';
    });
    const head = outcome(() => gate.run(headWork));
    const tail = outcome(() => gate.run(tailWork));
    pending.push(head, tail);
    // Flush admission/microtasks without moving time towards any waiting deadline.
    await vi.advanceTimersByTimeAsync(0);
    expect([gate.running, gate.waiting]).toEqual([1, 2]);
    expect(headWork).not.toHaveBeenCalled();
    expect(tailWork).not.toHaveBeenCalled();

    fail.resolve();
    expect(await first).toEqual({ thrown: failure });
    await vi.advanceTimersByTimeAsync(0);
    expect(headWork).toHaveBeenCalledTimes(1);
    expect(tailWork).not.toHaveBeenCalled();
    expect(order).toEqual(['head']);
    expect([gate.running, gate.waiting]).toEqual([1, 1]);

    releaseHead.resolve();
    expect(await head).toEqual({ kind: 'completed', value: 'synthetic-head' });
    expect(await tail).toEqual({ kind: 'completed', value: 'synthetic-tail' });
    expect(order).toEqual(['head', 'tail']);
    expect(tailWork).toHaveBeenCalledTimes(1);
    expect([gate.running, gate.waiting]).toEqual([0, 0]);
  } finally {
    fail.resolve();
    releaseHead.resolve();
    // Let a broken handoff settle as a refusal during cleanup, preserving the assertion error.
    await vi.runAllTimersAsync();
    await Promise.allSettled(pending);
    vi.useRealTimers();
  }
}, 10_000);
