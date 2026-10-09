// 规则测试（B1-14b）：降级登记表经 platform 公共出口可用，且登记表原语义不变（规划/02 §14 外部依赖与
// 降级、§6.2 治理层；契约是 apps/api/src/modules/platform/resilience/index.ts 的头注释）。
// 工厂只经公共出口的命名空间取得（kit.publicRegistryFactory）；缺出口时断言失败，自然红。
// 期望值一律手写字面量。只用顶层 it（规划/11 §4.3）。
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ResilienceOverrides } from '../../../../apps/api/src/modules/platform/resilience/index.ts';
import { fastQwenOverrides, publicRegistryFactory } from './kit.ts';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof GovernanceError) return error.code;
    return `error: ${error instanceof Error ? error.name : String(error)}`;
  }
  return 'returned';
}

it('[AC-B1-14b-001][B1-14b 公共出口] platform/index.ts 暴露 createResilienceRegistry，且是可调用的工厂', () => {
  const factory = publicRegistryFactory();
  const registry = factory();
  expect({
    entries: typeof registry.entries,
    entry: typeof registry.entry,
  }).toEqual({ entries: 'function', entry: 'function' });
});

it('[AC-B1-14b-002][02 §14 登记范围] 经公共出口取得的登记表：七行内容与顺序不变', () => {
  const rows = publicRegistryFactory()()
    .entries()
    .map((e) => ({
      dependency: e.dependency,
      ownerModule: e.ownerModule,
      failureModes: [...e.failureModes],
      degrade: { action: e.degrade.action, errorCode: e.degrade.errorCode },
      switches: [...e.switches],
    }));
  expect(rows).toEqual([
    {
      dependency: 'union.search',
      ownerModule: 'catalog',
      failureModes: ['timeout', 'rate_limited'],
      degrade: { action: 'stale_cache_or_error', errorCode: 50304 },
      switches: [],
    },
    {
      dependency: 'union.tpwd_parse',
      ownerModule: 'parsing',
      failureModes: ['permission_missing'],
      degrade: { action: 'guide_title_search', errorCode: 30132 },
      switches: ['parse.tpwd.enabled'],
    },
    {
      dependency: 'model.qwen',
      ownerModule: 'agent',
      failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
      degrade: { action: 'backup_then_no_model', errorCode: 50302 },
      switches: ['agent.model_route', 'agent.enabled'],
    },
    {
      dependency: 'judge.jev',
      ownerModule: 'judge',
      failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
      degrade: { action: 'rules_only', errorCode: null },
      switches: ['jev.enabled', 'agent.result_check.provider'],
    },
    {
      dependency: 'content_safety',
      ownerModule: 'agent',
      failureModes: ['timeout'],
      degrade: { action: 'fail_closed', errorCode: null },
      switches: [],
    },
    {
      dependency: 'sms',
      ownerModule: 'notification',
      failureModes: ['channel_down'],
      degrade: { action: 'backup_provider', errorCode: null },
      switches: ['sms.provider'],
    },
    {
      dependency: 'push',
      ownerModule: 'notification',
      failureModes: ['channel_down'],
      degrade: { action: 'inbox_fallback', errorCode: null },
      switches: [],
    },
  ]);
});

it('[AC-B1-14b-003][02 §14 千问][BR-AI-14] 公共出口的 model.qwen 默认策略：单次不超过 8000 毫秒、不重试；联盟两行仍是 02 §6.2 在线值', () => {
  const registry = publicRegistryFactory()();
  const qwen = registry.entry('model.qwen').policy;
  expect({
    qwenTimeoutPositiveInteger: Number.isInteger(qwen.timeoutMs) && qwen.timeoutMs >= 1,
    qwenWithinRunLimit: qwen.timeoutMs <= 8000,
    qwenMaxRetries: qwen.retries.maxRetries,
    search: registry.entry('union.search').policy,
    tpwd: registry.entry('union.tpwd_parse').policy,
    jev: {
      timeoutMs: registry.entry('judge.jev').policy.timeoutMs,
      maxRetries: registry.entry('judge.jev').policy.retries.maxRetries,
    },
    safety: {
      timeoutMs: registry.entry('content_safety').policy.timeoutMs,
      maxRetries: registry.entry('content_safety').policy.retries.maxRetries,
    },
  }).toEqual({
    qwenTimeoutPositiveInteger: true,
    qwenWithinRunLimit: true,
    qwenMaxRetries: 0,
    search: {
      timeoutMs: 3000,
      retries: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
      breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 },
    },
    tpwd: {
      timeoutMs: 3000,
      retries: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
      breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 },
    },
    jev: { timeoutMs: 400, maxRetries: 0 },
    safety: { timeoutMs: 1000, maxRetries: 0 },
  });
});

it('[AC-B1-14b-004][02 §14 覆盖] 公共出口的工厂按 model.qwen 覆盖合并 timeoutMs 与 breaker；其他行不受影响', () => {
  const factory = publicRegistryFactory();
  const registry = factory(fastQwenOverrides());
  const qwen = registry.entry('model.qwen').policy;
  expect({
    timeoutMs: qwen.timeoutMs,
    maxRetries: qwen.retries.maxRetries,
    breaker: qwen.breaker,
    jevTimeoutMs: registry.entry('judge.jev').policy.timeoutMs,
    searchBreaker: registry.entry('union.search').policy.breaker,
  }).toEqual({
    timeoutMs: 2500,
    maxRetries: 0,
    breaker: { windowMs: 10000, minRequests: 2, failureRatePercent: 50, openMs: 12000 },
    jevTimeoutMs: 400,
    searchBreaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 },
  });
});

it('[AC-B1-14b-005][02 §14 覆盖] 公共出口的工厂对非法覆盖照旧抛 GovernanceError(invalid_policy)', () => {
  const factory = publicRegistryFactory();
  const unknownDependency = { 'model.gpt': { timeoutMs: 1000 } } as unknown as ResilienceOverrides;
  const unknownField = { 'model.qwen': { attempts: 1 } } as unknown as ResilienceOverrides;
  expect({
    unknownDependency: codeOf(() => factory(unknownDependency)),
    unknownField: codeOf(() => factory(unknownField)),
    zeroTimeout: codeOf(() => factory({ 'model.qwen': { timeoutMs: 0 } })),
    rateOutOfRange: codeOf(() =>
      factory({ 'model.qwen': { breaker: { failureRatePercent: 100 } } }),
    ),
    valid: codeOf(() => factory({ 'model.qwen': { timeoutMs: 2500 } })),
  }).toEqual({
    unknownDependency: 'invalid_policy',
    unknownField: 'invalid_policy',
    zeroTimeout: 'invalid_policy',
    rateOutOfRange: 'invalid_policy',
    valid: 'returned',
  });
});

it('[AC-B1-14b-006][02 §14 登记表] 公共出口每次返回新对象：改动取到的条目不影响后续查询，也不影响另一份登记表', () => {
  const factory = publicRegistryFactory();
  const first = factory();
  const taken = first.entry('model.qwen');
  (taken.switches as string[]).push('synthetic.switch');
  (taken.failureModes as unknown as string[]).length = 0;
  (taken.policy.breaker as { openMs: number }).openMs = 1;
  const overridden = factory(fastQwenOverrides());
  expect({
    again: {
      switches: first.entry('model.qwen').switches,
      failureModes: first.entry('model.qwen').failureModes,
      openMsUntouched: first.entry('model.qwen').policy.breaker.openMs !== 1,
    },
    other: overridden.entry('model.qwen').policy.breaker.openMs,
    fresh: factory().entry('model.qwen').switches,
  }).toEqual({
    again: {
      switches: ['agent.model_route', 'agent.enabled'],
      failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
      openMsUntouched: true,
    },
    other: 12000,
    fresh: ['agent.model_route', 'agent.enabled'],
  });
});
