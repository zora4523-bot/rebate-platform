// Rule tests for the governance values of 规划/02 §6.2 治理层 (超时、重试、熔断、配额切分) and for
// the validation of policies. The numbers asserted here are the ones written in that table;
// the two backoff bounds (200 ms, 2 000 ms) are this module's own choice, documented in the
// header of apps/api/src/modules/platform/http/index.ts.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  type GovernancePolicy,
  createGovernor,
  quotaShares,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import { ManualScheduler, thrown } from './kit.ts';

it('[规划/02 §6.2] 超时：在线调用 3 秒，离线调用（同步、刷新）10 秒', () => {
  expect({
    online: unionPolicy('online').timeoutMs,
    offline: unionPolicy('offline').timeoutMs,
  }).toEqual({ online: 3000, offline: 10000 });
});

it('[规划/02 §6.2] 重试：最多 2 次，指数退避（200 毫秒起，单次不超过 2 秒）；在线与离线相同', () => {
  const retries = { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 };
  expect({
    online: unionPolicy('online').retries,
    offline: unionPolicy('offline').retries,
  }).toEqual({
    online: retries,
    offline: retries,
  });
});

it('[规划/02 §6.2] 熔断：10 秒窗口内请求不少于 20 次且错误率超过 50%，熔断 30 秒；在线与离线相同', () => {
  const breaker = { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 };
  expect({
    online: unionPolicy('online').breaker,
    offline: unionPolicy('offline').breaker,
  }).toEqual({ online: breaker, offline: breaker });
});

it('[规划/02 §6.2] 配额按用途切分：MVP 在线 60%、订单同步 30%、商品池刷新 10%；P1 提醒开启后商品池刷新 5%、提醒 5%', () => {
  expect({ mvp: quotaShares('mvp'), p1: quotaShares('p1') }).toEqual({
    mvp: { online: 60, order_sync: 30, pool_refresh: 10, watch: 0 },
    p1: { online: 60, order_sync: 30, pool_refresh: 5, watch: 5 },
  });
});

it('[规划/02 §6.2] unionPolicy 每次返回新的对象：改动返回值不影响下一次取到的策略', () => {
  const first = unionPolicy('online') as { timeoutMs: number; retries: { maxRetries: number } };
  try {
    first.timeoutMs = 1;
    first.retries.maxRetries = 9;
  } catch {
    // A frozen object is fine too: then nothing was changed.
  }
  expect({
    timeoutMs: unionPolicy('online').timeoutMs,
    maxRetries: unionPolicy('online').retries.maxRetries,
  }).toEqual({ timeoutMs: 3000, maxRetries: 2 });
});

it('[规划/02 §6.2] createGovernor 拒绝不合法的策略与空的依赖名：一律 invalid_policy，不带病运行', () => {
  const scheduler = new ManualScheduler();
  const base = unionPolicy('online');
  const withRetry = (patch: Partial<GovernancePolicy['retries']>): GovernancePolicy => ({
    ...base,
    retries: { ...base.retries, ...patch },
  });
  const withBreaker = (breaker: Partial<GovernancePolicy['breaker']>): GovernancePolicy => ({
    ...base,
    breaker: { ...base.breaker, ...breaker },
  });
  const bad: Record<string, GovernancePolicy> = {
    timeoutZero: { ...base, timeoutMs: 0 },
    timeoutNegative: { ...base, timeoutMs: -3000 },
    timeoutFraction: { ...base, timeoutMs: 0.5 },
    timeoutNaN: { ...base, timeoutMs: Number.NaN },
    timeoutInfinite: { ...base, timeoutMs: Number.POSITIVE_INFINITY },
    retriesNegative: withRetry({ maxRetries: -1 }),
    retriesFraction: withRetry({ maxRetries: 1.5 }),
    retriesTooMany: withRetry({ maxRetries: 11 }),
    baseDelayZero: withRetry({ baseDelayMs: 0 }),
    maxDelayBelowBase: withRetry({ baseDelayMs: 200, maxDelayMs: 199 }),
    windowZero: withBreaker({ windowMs: 0 }),
    minRequestsZero: withBreaker({ minRequests: 0 }),
    rateNegative: withBreaker({ failureRatePercent: -1 }),
    rateHundred: withBreaker({ failureRatePercent: 100 }),
    rateFraction: withBreaker({ failureRatePercent: 50.5 }),
    openZero: withBreaker({ openMs: 0 }),
  };
  const outcomes = Object.fromEntries(
    Object.entries(bad).map(([name, policy]) => [
      name,
      thrown(() => createGovernor('union.taobao', policy, { scheduler })),
    ]),
  );
  expect({
    outcomes,
    emptyName: thrown(() => createGovernor('', base, { scheduler })),
    good: thrown(() => createGovernor('union.taobao', base, { scheduler })),
    noRetry: thrown(() => createGovernor('alipay', withRetry({ maxRetries: 0 }), { scheduler })),
    name: createGovernor('union.taobao', base, { scheduler }).dependency,
    initialState: createGovernor('union.taobao', base, { scheduler }).breakerState(),
  }).toEqual({
    outcomes: Object.fromEntries(Object.keys(bad).map((name) => [name, 'invalid_policy'])),
    emptyName: 'invalid_policy',
    good: 'returned',
    noRetry: 'returned',
    name: 'union.taobao',
    initialState: 'closed',
  });
});
