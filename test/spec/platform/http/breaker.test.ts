// Rule tests for 规划/02 §6.2 治理层「熔断：10 秒窗口内错误率 >50% 且请求 ≥20 次，熔断 30 秒；
// 熔断期间按降级表处理」. While open the governor rejects with `circuit_open` without calling
// the dependency, which is what lets the caller fall back to its row of the 规划/02 §14 table.
// Calls here are writes (one attempt per call) unless a test says otherwise; time is the
// ManualScheduler of kit.ts. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type GovernancePolicy,
  createGovernor,
  createMemoryQuotaLimiter,
  quotaShares,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import { ManualScheduler, Upstream, ending, flush, observe, runCalls, tally } from './kit.ts';

const WRITE = { kind: 'write' } as const;

function setup(name: string = 'union.taobao'): {
  scheduler: ManualScheduler;
  upstream: Upstream;
  governor: ReturnType<typeof createGovernor>;
} {
  const scheduler = new ManualScheduler();
  return {
    scheduler,
    upstream: new Upstream(scheduler),
    governor: createGovernor(name, unionPolicy('online'), { scheduler }),
  };
}

it('[规划/02 §6.2] 错误率正好 50% 不熔断（20 次里失败 10 次）；再失败 1 次（21 次里 11 次）才熔断', async () => {
  const { upstream, governor } = setup();
  await runCalls(governor, 10, upstream.ok('fine'), WRITE);
  const failures = await runCalls(governor, 10, upstream.down(), WRITE);
  const atFiftyPercent = governor.breakerState();
  await runCalls(governor, 1, upstream.down(), WRITE);
  const invokedBefore = upstream.calledAt.length;
  const next = await runCalls(governor, 1, upstream.ok('fine'), WRITE);
  expect({
    failures: tally(failures),
    atFiftyPercent,
    afterEleventhFailure: governor.breakerState(),
    next,
    invokedWhileOpen: upstream.calledAt.length - invokedBefore,
  }).toEqual({
    failures: {
      'error: upstream down #11': 1,
      'error: upstream down #12': 1,
      'error: upstream down #13': 1,
      'error: upstream down #14': 1,
      'error: upstream down #15': 1,
      'error: upstream down #16': 1,
      'error: upstream down #17': 1,
      'error: upstream down #18': 1,
      'error: upstream down #19': 1,
      'error: upstream down #20': 1,
    },
    atFiftyPercent: 'closed',
    afterEleventhFailure: 'open',
    next: ['circuit_open'],
    invokedWhileOpen: 0,
  });
});

it('[规划/02 §6.2] 请求不足 20 次不熔断：19 次全部失败仍放行；第 20 次失败后熔断', async () => {
  const { upstream, governor } = setup();
  await runCalls(governor, 19, upstream.down(), WRITE);
  const afterNineteen = governor.breakerState();
  await runCalls(governor, 1, upstream.down(), WRITE);
  const afterTwenty = governor.breakerState();
  const next = await runCalls(governor, 3, upstream.down(), WRITE);
  expect({ afterNineteen, afterTwenty, next, invoked: upstream.calledAt.length }).toEqual({
    afterNineteen: 'closed',
    afterTwenty: 'open',
    next: ['circuit_open', 'circuit_open', 'circuit_open'],
    invoked: 20,
  });
});

it('[规划/02 §6.2] 熔断 30 秒：29999 毫秒时仍拒绝，30000 毫秒时放行，并从空窗口重新计数', async () => {
  const { scheduler, upstream, governor } = setup();
  await runCalls(governor, 20, upstream.down(), WRITE);
  await scheduler.advance(29999);
  const justBefore = await runCalls(governor, 1, upstream.ok('fine'), WRITE);
  await scheduler.advance(1);
  const stateAtThirtySeconds = governor.breakerState();
  const justAfter = await runCalls(governor, 1, upstream.ok('fine'), WRITE);
  // The 20 failures from before the opening are gone: 19 new failures after one success make
  // 19 of 20 attempts, which is above 50 % with at least 20 attempts → open again; 18 would not.
  await runCalls(governor, 18, upstream.down(), WRITE);
  const afterEighteen = governor.breakerState();
  await runCalls(governor, 1, upstream.down(), WRITE);
  expect({
    justBefore,
    stateAtThirtySeconds,
    justAfter,
    afterEighteen,
    afterNineteen: governor.breakerState(),
  }).toEqual({
    justBefore: ['circuit_open'],
    stateAtThirtySeconds: 'closed',
    justAfter: ['resolved'],
    afterEighteen: 'closed',
    afterNineteen: 'open',
  });
});

it('[规划/02 §6.2] 熔断结束后从空窗口重新计数：熔断时间比窗口短时，熔断前的失败也不会让它马上再次熔断', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  // Open for 1 s only, window still 10 s: the 20 failures that opened the breaker are younger
  // than the window when it closes again.
  const policy: GovernancePolicy = {
    ...unionPolicy('online'),
    breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 1000 },
  };
  const governor = createGovernor('sms.aliyun', policy, { scheduler });
  await runCalls(governor, 20, upstream.down(), WRITE);
  const opened = governor.breakerState();
  await scheduler.advance(1000);
  const oneFailure = await runCalls(governor, 1, upstream.down(), WRITE);
  const afterOneFailure = governor.breakerState();
  await runCalls(governor, 18, upstream.down(), WRITE);
  const afterNineteen = governor.breakerState();
  await runCalls(governor, 1, upstream.down(), WRITE);
  expect({
    opened,
    oneFailure,
    afterOneFailure,
    afterNineteen,
    afterTwenty: governor.breakerState(),
  }).toEqual({
    opened: 'open',
    oneFailure: ['error: upstream down #21'],
    afterOneFailure: 'closed',
    afterNineteen: 'closed',
    afterTwenty: 'open',
  });
});

it('[规划/02 §6.2] 窗口是 10 秒：9999 毫秒前的失败还算数，满 10000 毫秒的不再计入', async () => {
  const stillCounted = setup();
  await runCalls(stillCounted.governor, 15, stillCounted.upstream.down(), WRITE);
  await stillCounted.scheduler.advance(9999);
  await runCalls(stillCounted.governor, 5, stillCounted.upstream.down(), WRITE);

  const expired = setup();
  await runCalls(expired.governor, 15, expired.upstream.down(), WRITE);
  await expired.scheduler.advance(10000);
  await runCalls(expired.governor, 5, expired.upstream.down(), WRITE);
  const afterFive = expired.governor.breakerState();
  // Only the 5 recent failures are in the window; 15 more reach 20 of 20.
  await runCalls(expired.governor, 14, expired.upstream.down(), WRITE);
  const afterNineteenRecent = expired.governor.breakerState();
  await runCalls(expired.governor, 1, expired.upstream.down(), WRITE);
  expect({
    stillCounted: stillCounted.governor.breakerState(),
    afterFive,
    afterNineteenRecent,
    afterTwentyRecent: expired.governor.breakerState(),
  }).toEqual({
    stillCounted: 'open',
    afterFive: 'closed',
    afterNineteenRecent: 'closed',
    afterTwentyRecent: 'open',
  });
});

it('[规划/02 §6.2] 成功与对方明确答复的拒绝都算正常请求：10 次拒绝 + 10 次故障是 50%，不熔断；换成 9 次拒绝 + 11 次故障就熔断', async () => {
  const rejectedIsGood = setup();
  await runCalls(rejectedIsGood.governor, 10, rejectedIsGood.upstream.down(), {
    kind: 'write',
    classify: () => 'rejected',
  });
  await runCalls(rejectedIsGood.governor, 10, rejectedIsGood.upstream.down(), WRITE);

  const oneMoreFailure = setup();
  await runCalls(oneMoreFailure.governor, 9, oneMoreFailure.upstream.down(), {
    kind: 'write',
    classify: () => 'rejected',
  });
  await runCalls(oneMoreFailure.governor, 11, oneMoreFailure.upstream.down(), WRITE);
  expect({
    tenRejectedTenFailed: rejectedIsGood.governor.breakerState(),
    nineRejectedElevenFailed: oneMoreFailure.governor.breakerState(),
  }).toEqual({ tenRejectedTenFailed: 'closed', nineRejectedElevenFailed: 'open' });
});

it('[规划/02 §6.2] 超时按故障计入熔断：20 次调用全部超时后熔断', async () => {
  const { scheduler, upstream, governor } = setup();
  // 20 concurrent writes that all hang: each one times out at 3000 ms.
  const calls = Array.from({ length: 20 }, () => observe(governor.call(upstream.hang(), WRITE)));
  await scheduler.advance(2999);
  const before = governor.breakerState();
  await scheduler.advance(1);
  expect({
    before,
    after: governor.breakerState(),
    endings: tally(calls.map((call) => ending(call))),
  }).toEqual({ before: 'closed', after: 'open', endings: { timeout: 20 } });
});

it('[规划/02 §6.2] 每次尝试都计数，重试途中熔断即停：窗口里已有 19 次失败，幂等读第 1 次尝试失败后熔断，不再重试，以 circuit_open 结束', async () => {
  const { scheduler, upstream, governor } = setup();
  await runCalls(governor, 19, upstream.down(), WRITE);
  const read = observe(governor.call(upstream.down(), { kind: 'idempotent_read' }));
  await scheduler.advance(1000);
  expect({
    state: governor.breakerState(),
    ending: ending(read),
    invoked: upstream.calledAt.length,
  }).toEqual({ state: 'open', ending: 'circuit_open', invoked: 20 });
});

it('[规划/02 §6.2] 熔断期间被拒的调用不取配额令牌，也不计入窗口', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const quota = createMemoryQuotaLimiter(
    {
      bucketKey: 'union:taobao:acct-1',
      capacity: 100,
      refillPerSecond: 1,
      shares: quotaShares('mvp'),
    },
    scheduler,
  );
  const governor = createGovernor('union.taobao', unionPolicy('online'), { scheduler, quota });
  const orderSync = { kind: 'write', purpose: 'order_sync' } as const;
  // 20 failing attempts use 20 of the 30 order-sync tokens and open the breaker.
  await runCalls(governor, 20, upstream.down(), orderSync);
  const whileOpen = await runCalls(governor, 50, upstream.down(), orderSync);
  await scheduler.advance(30000);
  // 30 s of refill at 0.3 tokens per second give 9 tokens: 10 + 9 = 19 are left, so 19 calls
  // get through and the 20th is out of quota. Had the 50 rejected calls taken tokens, none
  // would get through.
  const afterReopen = await runCalls(governor, 20, upstream.ok('fine'), orderSync);
  expect({
    whileOpen: tally(whileOpen),
    afterReopen: tally(afterReopen),
    state: governor.breakerState(),
    invoked: upstream.calledAt.length,
  }).toEqual({
    whileOpen: { circuit_open: 50 },
    afterReopen: { resolved: 19, quota_exceeded: 1 },
    state: 'closed',
    invoked: 39,
  });
});

it('[规划/02 §6.2] 每个依赖各有自己的熔断器：一个平台熔断不影响另一个平台', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const taobao = createGovernor('union.taobao', unionPolicy('online'), { scheduler });
  const jd = createGovernor('union.jd', unionPolicy('online'), { scheduler });
  await runCalls(taobao, 20, upstream.down(), WRITE);
  const jdCall = observe(jd.call(upstream.ok('jd fine'), WRITE));
  await flush();
  expect({
    taobao: taobao.breakerState(),
    jd: jd.breakerState(),
    jdCall: [ending(jdCall), jdCall.value],
  }).toEqual({ taobao: 'open', jd: 'closed', jdCall: ['resolved', 'jd fine'] });
});
