// Rule tests for 规划/02 §6.2 治理层「配额：令牌桶；桶的键按可配置键实现；按用途切分：MVP 在线
// 60%、订单同步 30%、商品池刷新 10%；P1 提醒开启后商品池刷新 5%、提醒 5%；在线余量不足时先暂停
// 商品池刷新」, on the in-process limiter. The bucket numbers of the real platforms wait for
// CAP-*-12; the tests use round numbers. Time is the ManualScheduler of kit.ts.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type QuotaConfig,
  type QuotaLimiter,
  type QuotaPurpose,
  createGovernor,
  createMemoryQuotaLimiter,
  quotaShares,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import { ManualScheduler, Upstream, ending, observe, runCalls, tally, thrown } from './kit.ts';

function config(overrides: Partial<QuotaConfig> = {}): QuotaConfig {
  return {
    bucketKey: 'union:taobao:acct-1',
    capacity: 100,
    refillPerSecond: 10,
    shares: quotaShares('mvp'),
    ...overrides,
  };
}

/** How many tokens `purpose` yields right now (stops at the first refusal, at most `limit`). */
function drain(limiter: QuotaLimiter, purpose: QuotaPurpose, limit: number = 1000): number {
  let taken = 0;
  while (taken < limit && limiter.tryAcquire(purpose)) taken += 1;
  return taken;
}

it('[规划/02 §6.2] 按用途切分令牌：容量 100 时订单同步 30、商品池刷新 10、提醒 0、在线 60，桶初始是满的', () => {
  const limiter = createMemoryQuotaLimiter(config(), new ManualScheduler());
  // Pool refresh is drained before online, so that online cannot take from it here.
  expect({
    order_sync: drain(limiter, 'order_sync'),
    pool_refresh: drain(limiter, 'pool_refresh'),
    watch: drain(limiter, 'watch'),
    online: drain(limiter, 'online'),
  }).toEqual({ order_sync: 30, pool_refresh: 10, watch: 0, online: 60 });
});

it('[规划/02 §6.2] P1 的切分：容量 100 时商品池刷新 5、提醒 5、订单同步 30、在线 60', () => {
  const limiter = createMemoryQuotaLimiter(
    config({ shares: quotaShares('p1') }),
    new ManualScheduler(),
  );
  expect({
    watch: drain(limiter, 'watch'),
    pool_refresh: drain(limiter, 'pool_refresh'),
    order_sync: drain(limiter, 'order_sync'),
    online: drain(limiter, 'online'),
  }).toEqual({ watch: 5, pool_refresh: 5, order_sync: 30, online: 60 });
});

it('[规划/02 §6.2] 在线余量不足时先让出商品池刷新：在线用完自己的 60 个后再取走商品池刷新的 10 个，商品池刷新随之暂停；订单同步的 30 个不受影响', () => {
  const limiter = createMemoryQuotaLimiter(config(), new ManualScheduler());
  expect({
    online: drain(limiter, 'online'),
    pool_refresh: drain(limiter, 'pool_refresh'),
    order_sync: drain(limiter, 'order_sync'),
    onlineAfterwards: drain(limiter, 'online'),
  }).toEqual({ online: 70, pool_refresh: 0, order_sync: 30, onlineAfterwards: 0 });
});

it('[规划/02 §6.2] 只有在线能借、只借商品池刷新：订单同步、提醒、商品池刷新用完自己的就被拒，不动别人的令牌', () => {
  const limiter = createMemoryQuotaLimiter(
    config({ shares: quotaShares('p1') }),
    new ManualScheduler(),
  );
  const first = {
    order_sync: drain(limiter, 'order_sync'),
    watch: drain(limiter, 'watch'),
    pool_refresh: drain(limiter, 'pool_refresh'),
  };
  expect({
    first,
    order_sync: limiter.tryAcquire('order_sync'),
    watch: limiter.tryAcquire('watch'),
    pool_refresh: limiter.tryAcquire('pool_refresh'),
    // Online still has all of its own 60; watch and order-sync tokens were never lent to it.
    online: drain(limiter, 'online'),
  }).toEqual({
    first: { order_sync: 30, watch: 5, pool_refresh: 5 },
    order_sync: false,
    watch: false,
    pool_refresh: false,
    online: 60,
  });
});

it('[规划/02 §6.2] 令牌按速率回填且不超过容量：订单同步每秒回填 总速率 × 30%，停一小时也只有 30 个', async () => {
  const scheduler = new ManualScheduler();
  const limiter = createMemoryQuotaLimiter(config({ refillPerSecond: 10 }), scheduler);
  const initial = drain(limiter, 'order_sync');
  await scheduler.advance(1000);
  const afterOneSecond = drain(limiter, 'order_sync');
  await scheduler.advance(333);
  const afterAThirdOfASecond = drain(limiter, 'order_sync');
  await scheduler.advance(1);
  const oneMillisecondLater = drain(limiter, 'order_sync');
  await scheduler.advance(3_600_000);
  expect({
    initial,
    afterOneSecond,
    afterAThirdOfASecond,
    oneMillisecondLater,
    afterAnHour: drain(limiter, 'order_sync'),
  }).toEqual({
    initial: 30,
    // 10 tokens per second × 30 % = 3 per second.
    afterOneSecond: 3,
    // 333 ms give 0.999 of a token: not a whole one yet; 1 ms more completes it.
    afterAThirdOfASecond: 0,
    oneMillisecondLater: 1,
    afterAnHour: 30,
  });
});

it('[规划/02 §6.2] 份额算出的容量向下取整：容量 15 时在线 9、订单同步 4、商品池刷新 1、提醒 0', () => {
  const limiter = createMemoryQuotaLimiter(config({ capacity: 15 }), new ManualScheduler());
  expect({
    order_sync: drain(limiter, 'order_sync'),
    pool_refresh: drain(limiter, 'pool_refresh'),
    watch: drain(limiter, 'watch'),
    online: drain(limiter, 'online'),
  }).toEqual({ order_sync: 4, pool_refresh: 1, watch: 0, online: 9 });
});

it('[规划/02 §6.2] 桶的键可配置：limiter 带着配置的键，不同键的桶互不影响', () => {
  const scheduler = new ManualScheduler();
  const byAccount = createMemoryQuotaLimiter(
    config({ bucketKey: 'union:taobao:acct-1' }),
    scheduler,
  );
  const byAppKey = createMemoryQuotaLimiter(
    config({ bucketKey: 'union:taobao:appkey-9' }),
    scheduler,
  );
  const drained = drain(byAccount, 'order_sync');
  expect({
    keys: [byAccount.bucketKey, byAppKey.bucketKey],
    drained,
    otherBucketUntouched: drain(byAppKey, 'order_sync'),
  }).toEqual({
    keys: ['union:taobao:acct-1', 'union:taobao:appkey-9'],
    drained: 30,
    otherBucketUntouched: 30,
  });
});

it('[规划/02 §6.2] 不合法的配额配置一律 invalid_policy：份额不是 0 到 100 的整数或合计不是 100、容量不是正整数、速率不是正数、键为空', () => {
  const scheduler = new ManualScheduler();
  const shares = quotaShares('mvp');
  const bad: Record<string, QuotaConfig> = {
    sharesSumBelow: config({ shares: { ...shares, online: 59 } }),
    sharesSumAbove: config({ shares: { ...shares, watch: 1 } }),
    shareNegative: config({ shares: { ...shares, online: 70, watch: -10 } }),
    shareFraction: config({ shares: { ...shares, online: 59.5, watch: 0.5 } }),
    shareMissing: config({
      shares: { online: 70, order_sync: 30 } as unknown as QuotaConfig['shares'],
    }),
    capacityZero: config({ capacity: 0 }),
    capacityFraction: config({ capacity: 10.5 }),
    capacityNegative: config({ capacity: -100 }),
    refillZero: config({ refillPerSecond: 0 }),
    refillNegative: config({ refillPerSecond: -1 }),
    refillNaN: config({ refillPerSecond: Number.NaN }),
    refillInfinite: config({ refillPerSecond: Number.POSITIVE_INFINITY }),
    keyEmpty: config({ bucketKey: '' }),
  };
  expect({
    bad: Object.fromEntries(
      Object.entries(bad).map(([name, value]) => [
        name,
        thrown(() => createMemoryQuotaLimiter(value, scheduler)),
      ]),
    ),
    good: thrown(() => createMemoryQuotaLimiter(config(), scheduler)),
    fractionalRefillIsFine: thrown(() =>
      createMemoryQuotaLimiter(config({ refillPerSecond: 0.5 }), scheduler),
    ),
  }).toEqual({
    bad: Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_policy'])),
    good: 'returned',
    fractionalRefillIsFine: 'returned',
  });
});

it('[规划/02 §6.2] Governor 每次尝试取 1 个令牌：幂等读重试 2 次共取 3 个；令牌不够时以 quota_exceeded 结束，不调用对方', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  // 10 tokens, all for order sync; the refill is negligible within this test.
  const quota = createMemoryQuotaLimiter(
    {
      bucketKey: 'union:jd:acct-1',
      capacity: 10,
      refillPerSecond: 0.000001,
      shares: { online: 0, order_sync: 100, pool_refresh: 0, watch: 0 },
    },
    scheduler,
  );
  const governor = createGovernor('union.jd', unionPolicy('offline'), { scheduler, quota });
  const read = { kind: 'idempotent_read', purpose: 'order_sync' } as const;
  // Three failing reads: 3 attempts each = 9 tokens.
  const firstThree = [0, 1, 2].map(() => observe(governor.call(upstream.down(), read)));
  await scheduler.advance(5000);
  const invokedAfterThree = upstream.calledAt.length;
  // The fourth read gets the last token for its first attempt; its retry finds none.
  const fourth = observe(governor.call(upstream.down(), read));
  await scheduler.advance(5000);
  const fifth = observe(governor.call(upstream.ok('never reached'), read));
  await scheduler.advance(5000);
  expect({
    firstThree: tally(firstThree.map((call) => ending(call))),
    invokedAfterThree,
    fourth: ending(fourth),
    fifth: ending(fifth),
    invoked: upstream.calledAt.length,
    left: drain(quota, 'order_sync'),
  }).toEqual({
    firstThree: {
      'error: upstream down #7': 1,
      'error: upstream down #8': 1,
      'error: upstream down #9': 1,
    },
    invokedAfterThree: 9,
    fourth: 'quota_exceeded',
    fifth: 'quota_exceeded',
    invoked: 10,
    left: 0,
  });
});

it('[规划/02 §6.2] 被配额拒绝不算对方故障：再多的 quota_exceeded 也不会让熔断器打开；不带 purpose 的调用不取令牌', async () => {
  const scheduler = new ManualScheduler();
  const upstream = new Upstream(scheduler);
  const quota = createMemoryQuotaLimiter(
    {
      bucketKey: 'union:pdd:acct-1',
      capacity: 5,
      refillPerSecond: 0.000001,
      shares: { online: 100, order_sync: 0, pool_refresh: 0, watch: 0 },
    },
    scheduler,
  );
  const governor = createGovernor('union.pdd', unionPolicy('online'), { scheduler, quota });
  const online = { kind: 'write', purpose: 'online' } as const;
  const withPurpose = await runCalls(governor, 45, upstream.ok('fine'), online);
  const stateAfterRefusals = governor.breakerState();
  const withoutPurpose = await runCalls(governor, 3, upstream.ok('fine'), { kind: 'write' });
  expect({
    withPurpose: tally(withPurpose),
    stateAfterRefusals,
    withoutPurpose: tally(withoutPurpose),
    invoked: upstream.calledAt.length,
  }).toEqual({
    withPurpose: { resolved: 5, quota_exceeded: 40 },
    stateAfterRefusals: 'closed',
    withoutPurpose: { resolved: 3 },
    invoked: 8,
  });
});
