// Rule tests for 规划/02 §6.2 治理层「超时：在线调用 3 秒；离线（同步、刷新）10 秒」: one attempt
// that has not answered within the limit is aborted and fails with `timeout`. Time is the
// ManualScheduler of kit.ts; nothing waits in real time. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  GovernanceError,
  createGovernor,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import { ManualScheduler, Upstream, ending, flush, observe } from './kit.ts';

it('[规划/02 §6.2] 在线调用 3 秒超时：2999 毫秒时还在等，3000 毫秒时中止信号触发并以 timeout 结束', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const call = observe(governor.call(upstream.hang(), { kind: 'write' }));
  await scheduler.advance(2999);
  const before = { ending: ending(call), aborted: upstream.signals[0]?.aborted };
  await scheduler.advance(1);
  const error = call.error;
  expect({
    before,
    after: { ending: ending(call), aborted: upstream.signals[0]?.aborted },
    isGovernanceError: error instanceof GovernanceError,
    dependency: error instanceof GovernanceError ? error.dependency : null,
    attempts: upstream.calledAt,
    pendingWaits: scheduler.pending,
  }).toEqual({
    before: { ending: 'pending', aborted: false },
    after: { ending: 'timeout', aborted: true },
    isGovernanceError: true,
    dependency: 'union.taobao',
    attempts: [0],
    pendingWaits: 0,
  });
});

it('[规划/02 §6.2] 离线调用 10 秒超时：9999 毫秒时还在等，10000 毫秒时以 timeout 结束', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.jd', unionPolicy('offline'), { scheduler });
  const call = observe(governor.call(upstream.hang(), { kind: 'write' }));
  await scheduler.advance(9999);
  const before = ending(call);
  await scheduler.advance(1);
  expect({ before, after: ending(call), aborted: upstream.signals[0]?.aborted }).toEqual({
    before: 'pending',
    after: 'timeout',
    aborted: true,
  });
});

it('[规划/02 §6.2] 限时内返回的调用：结果原样返回，信号不被中止，超时的等待被取消（调度器里不留等待）', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.pdd', unionPolicy('online'), { scheduler });
  const fast = observe(governor.call(upstream.ok({ items: 3 }), { kind: 'idempotent_read' }));
  await flush();
  const slow = observe(governor.call(upstream.slow(2999, 'late but in time'), { kind: 'write' }));
  await scheduler.advance(2999);
  expect({
    fast: [ending(fast), fast.value],
    slow: [ending(slow), slow.value],
    aborted: upstream.signals.map((signal) => signal.aborted),
    pendingWaits: scheduler.pending,
  }).toEqual({
    fast: ['resolved', { items: 3 }],
    slow: ['resolved', 'late but in time'],
    aborted: [false, false],
    pendingWaits: 0,
  });
});

it('[规划/02 §6.2] 超时之后才到的回答被丢弃：调用仍以 timeout 结束，不会事后变成成功', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  // The operation ignores the abort signal and answers 1 ms after the limit.
  const call = observe(governor.call(upstream.slow(3001, 'too late'), { kind: 'write' }));
  await scheduler.advance(3000);
  const atLimit = ending(call);
  await scheduler.advance(10);
  expect({ atLimit, afterLateAnswer: ending(call), value: call.value }).toEqual({
    atLimit: 'timeout',
    afterLateAnswer: 'timeout',
    value: undefined,
  });
});

it('[规划/02 §6.2] 超时按每次尝试计：一次调用里每个尝试各有自己的 3 秒', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const call = observe(governor.call(upstream.hang(), { kind: 'idempotent_read' }));
  // Attempt 1 at 0 times out at 3000; backoff 200; attempt 2 at 3200 times out at 6200;
  // backoff 400; attempt 3 at 6600 times out at 9600.
  await scheduler.advance(9599);
  const before = ending(call);
  await scheduler.advance(1);
  expect({
    before,
    after: ending(call),
    attempts: upstream.calledAt,
    aborted: upstream.signals.map((signal) => signal.aborted),
    pendingWaits: scheduler.pending,
  }).toEqual({
    before: 'pending',
    after: 'timeout',
    attempts: [0, 3200, 6600],
    aborted: [true, true, true],
    pendingWaits: 0,
  });
});
