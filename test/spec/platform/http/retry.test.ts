// Rule tests for 规划/02 §6.2 治理层「重试：只重试幂等读，最多 2 次，指数退避；转链不自动重试
// （由客户端重放同一幂等键）」. Attempt times are read from the ManualScheduler, so the backoff
// is asserted to the millisecond. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type GovernancePolicy,
  createGovernor,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import { ManualScheduler, Upstream, ending, flush, observe } from './kit.ts';

it('[规划/02 §6.2] 幂等读失败后最多再试 2 次（共 3 次），退避 200、400 毫秒；都失败则以最后一次的错误结束', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const call = observe(governor.call(upstream.down(), { kind: 'idempotent_read' }));
  await scheduler.advance(199);
  const beforeFirstRetry = [...upstream.calledAt];
  await scheduler.advance(1);
  const afterFirstRetry = [...upstream.calledAt];
  await scheduler.advance(399);
  const beforeSecondRetry = [...upstream.calledAt];
  await scheduler.advance(1);
  await scheduler.advance(60000);
  expect({
    beforeFirstRetry,
    afterFirstRetry,
    beforeSecondRetry,
    attempts: upstream.calledAt,
    ending: ending(call),
    pendingWaits: scheduler.pending,
  }).toEqual({
    beforeFirstRetry: [0],
    afterFirstRetry: [0, 200],
    beforeSecondRetry: [0, 200],
    attempts: [0, 200, 600],
    ending: 'error: upstream down #3',
    pendingWaits: 0,
  });
});

it('[规划/02 §6.2] 写调用（转链等非幂等调用）失败不重试：只调用 1 次，错误原样抛出', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const call = observe(governor.call(upstream.down(), { kind: 'write' }));
  await scheduler.advance(60000);
  const timedOut = observe(governor.call(upstream.hang(), { kind: 'write' }));
  await scheduler.advance(60000);
  expect({
    attempts: upstream.calledAt,
    ending: ending(call),
    timedOutWrite: ending(timedOut),
    pendingWaits: scheduler.pending,
  }).toEqual({
    // One attempt for the failing write, one (at 60000) for the write that timed out.
    attempts: [0, 60000],
    ending: 'error: upstream down #1',
    timedOutWrite: 'timeout',
    pendingWaits: 0,
  });
});

it('[规划/02 §6.2] 重试成功就返回：第 2 次成功不再试第 3 次；第 3 次才成功也返回结果', async () => {
  const scheduler = new ManualScheduler();
  const first = new Upstream(scheduler);
  const second = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const a = observe(governor.call(first.downThenOk(1, 'second try'), { kind: 'idempotent_read' }));
  const b = observe(governor.call(second.downThenOk(2, 'third try'), { kind: 'idempotent_read' }));
  await scheduler.advance(60000);
  expect({
    a: [ending(a), a.value, first.calledAt],
    b: [ending(b), b.value, second.calledAt],
    pendingWaits: scheduler.pending,
  }).toEqual({
    a: ['resolved', 'second try', [0, 200]],
    b: ['resolved', 'third try', [0, 200, 600]],
    pendingWaits: 0,
  });
});

it('[规划/02 §6.2] 第一次就成功的幂等读不重试、不等待', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const call = observe(governor.call(upstream.ok('hit'), { kind: 'idempotent_read' }));
  await flush();
  expect({
    ending: ending(call),
    value: call.value,
    attempts: upstream.calledAt,
    pendingWaits: scheduler.pending,
  }).toEqual({ ending: 'resolved', value: 'hit', attempts: [0], pendingWaits: 0 });
});

it('[规划/02 §6.2] 对方明确答复的拒绝（classify 返回 rejected）不是故障：不重试，错误原样抛出', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const seen: unknown[] = [];
  const call = observe(
    governor.call(upstream.down(), {
      kind: 'idempotent_read',
      classify: (error) => {
        seen.push(error);
        return 'rejected';
      },
    }),
  );
  await scheduler.advance(60000);
  expect({
    attempts: upstream.calledAt,
    ending: ending(call),
    classifiedTheUpstreamError: seen.length === 1 && seen[0] === call.error,
  }).toEqual({
    attempts: [0],
    ending: 'error: upstream down #1',
    classifiedTheUpstreamError: true,
  });
});

it('[规划/02 §6.2] classify 返回 failure 时照常重试；超时永远按故障算，不交给 classify 改判', async () => {
  const scheduler = new ManualScheduler();
  const failing = new Upstream(scheduler);
  const hanging = new Upstream(scheduler);
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const a = observe(
    governor.call(failing.down(), { kind: 'idempotent_read', classify: () => 'failure' }),
  );
  // Even a classifier that calls everything `rejected` does not stop the retry of a timeout.
  const b = observe(
    governor.call(hanging.hang(), { kind: 'idempotent_read', classify: () => 'rejected' }),
  );
  await scheduler.advance(60000);
  expect({
    a: [ending(a), failing.calledAt],
    b: [ending(b), hanging.calledAt],
  }).toEqual({
    a: ['error: upstream down #3', [0, 200, 600]],
    b: ['timeout', [0, 3200, 6600]],
  });
});

it('[规划/02 §6.2] 指数退避有上限：base 100、max 300、重试 5 次 → 等待 100、200、300、300、300 毫秒', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const policy: GovernancePolicy = {
    ...unionPolicy('online'),
    retry: { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 300 },
  };
  const governor = createGovernor('model.qwen', policy, { scheduler });
  const call = observe(governor.call(upstream.down(), { kind: 'idempotent_read' }));
  await scheduler.advance(60000);
  expect({ attempts: upstream.calledAt, ending: ending(call) }).toEqual({
    attempts: [0, 100, 300, 600, 900, 1200],
    ending: 'error: upstream down #6',
  });
});

it('[规划/02 §6.2] 退避是指数而不是线性：base 100、重试 4 次 → 等待 100、200、400、800 毫秒', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const policy: GovernancePolicy = {
    ...unionPolicy('online'),
    retry: { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 60000 },
  };
  const governor = createGovernor('model.qwen', policy, { scheduler });
  const call = observe(governor.call(upstream.down(), { kind: 'idempotent_read' }));
  await scheduler.advance(60000);
  expect({ attempts: upstream.calledAt, ending: ending(call) }).toEqual({
    // A linear backoff (100, 200, 300, 400) would give 0, 100, 300, 600, 1000.
    attempts: [0, 100, 300, 700, 1500],
    ending: 'error: upstream down #5',
  });
});

it('[规划/02 §6.2] maxRetries 为 0 时幂等读也只试 1 次', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const policy: GovernancePolicy = {
    ...unionPolicy('online'),
    retry: { maxRetries: 0, baseDelayMs: 200, maxDelayMs: 2000 },
  };
  const governor = createGovernor('judge.jev', policy, { scheduler });
  const call = observe(governor.call(upstream.down(), { kind: 'idempotent_read' }));
  await scheduler.advance(60000);
  expect({ attempts: upstream.calledAt, ending: ending(call) }).toEqual({
    attempts: [0],
    ending: 'error: upstream down #1',
  });
});
