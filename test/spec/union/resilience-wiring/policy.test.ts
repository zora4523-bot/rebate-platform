import { expect, it } from 'vitest';
import { createResilienceRegistry } from '../../../../apps/api/src/modules/platform/index.ts';
import { expectFault, fault, GovernanceError, registry, rig } from './kit.ts';

// AC-B1-14d 是任务内验收标签；依据为编排者 D10-10 与规划/02 §6.2、§14。
it.each([80, 140])(
  '[AC-B1-14d#1] 在线使用 union.search 的 timeoutMs=%i，边界前仍等待，边界上取消且不重试',
  async (timeoutMs) => {
    const r = rig(registry({ timeoutMs }), fault('timeout'));
    const result = r.search();
    await r.advance(timeoutMs - 1);
    expect(result.settled).toBe('pending');
    expect(r.transport).toHaveBeenCalledTimes(1);
    expect(r.transport.mock.calls[0]![0].signal?.aborted).toBe(false);
    await r.advance(1);
    expectFault(result, 'timeout');
    expect(r.transport.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(r.transport).toHaveBeenCalledTimes(1);
    expect(r.take.mock.calls).toEqual([['online']]);
    expect(r.scheduler.pending).toBe(0);
  },
);

it.each([0, 1, 2])(
  '[AC-B1-14d#2] 幂等读应用 retries.maxRetries=%i 及覆盖的指数退避和上限',
  async (maxRetries) => {
    const r = rig(
      registry({ retries: { maxRetries }, breaker: { minRequests: 20 } }),
      fault('server_error'),
    );
    const result = r.search();
    await r.advance(0);
    if (maxRetries > 0) {
      expect(result.settled).toBe('pending');
      await r.advance(16);
      expect(r.transport).toHaveBeenCalledTimes(1);
      await r.advance(1);
    }
    if (maxRetries > 1) {
      expect(result.settled).toBe('pending');
      await r.advance(24);
      expect(r.transport).toHaveBeenCalledTimes(2);
      await r.advance(1);
    }
    expectFault(result, 'server_error');
    expect(r.calledAt).toEqual([0, 17, 42].slice(0, maxRetries + 1));
    expect(r.take).toHaveBeenCalledTimes(maxRetries + 1);
    await r.advance(1000);
    expect(r.transport).toHaveBeenCalledTimes(maxRetries + 1);
    expect(r.scheduler.pending).toBe(0);
  },
);

it('[AC-B1-14d#3] 缺省登记表与显式默认表保留 3 秒及两次重试，注入覆盖能改变同一调用', async () => {
  const outcomes: unknown[] = [];
  for (const resilience of [undefined, createResilienceRegistry(), registry()]) {
    const r = rig(resilience, fault('timeout'));
    const result = r.search();
    await r.advance(2999);
    outcomes.push({ settled: result.settled, calls: [...r.calledAt] });
    await r.advance(6601);
    expect(result.error).toBeInstanceOf(GovernanceError);
    outcomes.push({
      settled: result.settled,
      code: (result.error as GovernanceError).code,
      calls: [...r.calledAt],
      quota: r.take.mock.calls.length,
    });
  }
  expect(outcomes).toEqual([
    { settled: 'pending', calls: [0] },
    { settled: 'rejected', code: 'timeout', calls: [0, 3200, 6600], quota: 3 },
    { settled: 'pending', calls: [0] },
    { settled: 'rejected', code: 'timeout', calls: [0, 3200, 6600], quota: 3 },
    { settled: 'rejected', calls: [0] },
    { settled: 'rejected', code: 'timeout', calls: [0], quota: 1 },
  ]);
});
