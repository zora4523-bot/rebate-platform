// Rule tests for 「可按配置覆盖」 of the 规划/02 §14 degrade registry (task B1-14a): only the policy
// numbers (timeout, retries, breaker) can be overridden; the degrade, switches, failure modes and
// owner of a row cannot; a bad override is refused with invalid_policy instead of running with it.
// Contract: header of apps/api/src/modules/platform/resilience/index.ts. Top-level it() only.
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/http/index.ts';
import {
  type ResilienceOverrides,
  createResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/resilience/index.ts';
import { expectedRows, rowOf, unionOnlineLiteral } from './kit.ts';

/** The GovernanceError code thrown by `run`, 'none' when it returns, 'other' for anything else. */
function codeOf(run: () => unknown): string {
  try {
    run();
    return 'none';
  } catch (error) {
    if (error instanceof GovernanceError) return error.code;
    return error instanceof Error && error.message.startsWith('NotImplemented')
      ? error.message
      : 'other';
  }
}

it('[02 §14 可按配置覆盖] 覆盖 Jev 超时只改这一项：同行其余参数与其他各行的登记内容不变', () => {
  const changed = createResilienceRegistry({ 'judge.jev': { timeoutMs: 300 } });
  const jev = changed.entry('judge.jev');
  expect({
    jevTimeout: jev.policy.timeoutMs,
    jevMaxRetries: jev.policy.retries.maxRetries,
    rows: changed.entries().map(rowOf),
    searchPolicy: changed.entry('union.search').policy,
    tpwdPolicy: changed.entry('union.tpwd_parse').policy,
    safetyTimeout: changed.entry('content_safety').policy.timeoutMs,
  }).toEqual({
    jevTimeout: 300,
    jevMaxRetries: 0,
    rows: expectedRows(),
    searchPolicy: unionOnlineLiteral(),
    tpwdPolicy: unionOnlineLiteral(),
    safetyTimeout: 1000,
  });
});

it('[02 §14 可按配置覆盖] 嵌套字段可部分覆盖：只给 breaker.openMs 时窗口、次数、错误率保持默认', () => {
  const changed = createResilienceRegistry({ 'union.search': { breaker: { openMs: 60000 } } });
  expect(changed.entry('union.search').policy).toEqual({
    timeoutMs: 3000,
    retries: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
    breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 60000 },
  });
});

it('[02 §14 可按配置覆盖][BR-AI-18] 覆盖内容安全的超时与重试不改它的登记内容：覆盖实例、原实例、随后新建的实例都仍是 fail_closed', () => {
  const original = createResilienceRegistry();
  const changed = createResilienceRegistry({
    content_safety: { timeoutMs: 1500, retries: { maxRetries: 1 } },
  });
  const later = createResilienceRegistry();
  const expected = {
    dependency: 'content_safety',
    ownerModule: 'agent',
    failureModes: ['timeout'],
    degrade: { action: 'fail_closed', errorCode: null },
    switches: [],
  };
  expect({
    changedRow: rowOf(changed.entry('content_safety')),
    changedTimeout: changed.entry('content_safety').policy.timeoutMs,
    changedMaxRetries: changed.entry('content_safety').policy.retries.maxRetries,
    originalRow: rowOf(original.entry('content_safety')),
    originalTimeout: original.entry('content_safety').policy.timeoutMs,
    laterRow: rowOf(later.entry('content_safety')),
    laterTimeout: later.entry('content_safety').policy.timeoutMs,
  }).toEqual({
    changedRow: expected,
    changedTimeout: 1500,
    changedMaxRetries: 1,
    originalRow: expected,
    originalTimeout: 1000,
    laterRow: expected,
    laterTimeout: 1000,
  });
});

it('[02 §14 可按配置覆盖][BR-AI-14] 覆盖只作用于传入它的登记表：覆盖实例 300，原实例与之后新建的登记表仍是默认 400', () => {
  const original = createResilienceRegistry();
  const changed = createResilienceRegistry({ 'judge.jev': { timeoutMs: 300 } });
  const later = createResilienceRegistry();
  expect({
    changed: changed.entry('judge.jev').policy.timeoutMs,
    original: original.entry('judge.jev').policy.timeoutMs,
    later: later.entry('judge.jev').policy.timeoutMs,
  }).toEqual({ changed: 300, original: 400, later: 400 });
});

it('[02 §14 可按配置覆盖][BR-AI-14] 改动取到的条目不影响同一登记表的下一次读取，也不影响新建的登记表', () => {
  const registry = createResilienceRegistry();
  const first = registry.entry('judge.jev') as unknown as {
    switches: string[];
    degrade: { action: string };
    policy: { timeoutMs: number; retries: { maxRetries: number } };
  };
  try {
    first.policy.timeoutMs = 1;
    first.policy.retries.maxRetries = 9;
    first.switches.push('jev.extra');
    first.degrade.action = 'fail_open';
  } catch {
    // A frozen object is fine too: then nothing was changed.
  }
  const view = (registryUnderTest: ReturnType<typeof createResilienceRegistry>): unknown => {
    const e = registryUnderTest.entry('judge.jev');
    return {
      timeoutMs: e.policy.timeoutMs,
      maxRetries: e.policy.retries.maxRetries,
      switches: e.switches,
      action: e.degrade.action,
    };
  };
  const expected = {
    timeoutMs: 400,
    maxRetries: 0,
    switches: ['jev.enabled', 'agent.result_check.provider'],
    action: 'rules_only',
  };
  expect({ same: view(registry), fresh: view(createResilienceRegistry()) }).toEqual({
    same: expected,
    fresh: expected,
  });
});

it('[02 §14 可按配置覆盖] 不合法的数值一律 invalid_policy（超时 0 / 小数 / 负数、错误率 100、退避上限低于起点、重试 11 次）', () => {
  const bad: Record<string, ResilienceOverrides> = {
    timeoutZero: { push: { timeoutMs: 0 } },
    timeoutFraction: { sms: { timeoutMs: 0.5 } },
    timeoutNegative: { 'judge.jev': { timeoutMs: -400 } },
    rateHundred: { 'union.search': { breaker: { failureRatePercent: 100 } } },
    backoffInverted: { 'union.tpwd_parse': { retries: { baseDelayMs: 500, maxDelayMs: 100 } } },
    retriesEleven: { 'model.qwen': { retries: { maxRetries: 11 } } },
  };
  const codes = Object.fromEntries(
    Object.entries(bad).map(([name, overrides]) => [
      name,
      codeOf(() => createResilienceRegistry(overrides)),
    ]),
  );
  expect(codes).toEqual({
    timeoutZero: 'invalid_policy',
    timeoutFraction: 'invalid_policy',
    timeoutNegative: 'invalid_policy',
    rateHundred: 'invalid_policy',
    backoffInverted: 'invalid_policy',
    retriesEleven: 'invalid_policy',
  });
});

it('[02 §14 可按配置覆盖] 未登记的依赖、或想改降级动作与开关的覆盖，一律 invalid_policy（配置不能删改降级）', () => {
  const bad: Record<string, unknown> = {
    unknownDependency: { 'payout.alipay': { timeoutMs: 1000 } },
    degradeField: { content_safety: { degrade: { action: 'fail_open', errorCode: null } } },
    switchesField: { sms: { switches: [] } },
    unknownNested: { push: { breaker: { halfOpen: true } } },
  };
  const codes = Object.fromEntries(
    Object.entries(bad).map(([name, overrides]) => [
      name,
      codeOf(() => createResilienceRegistry(overrides as ResilienceOverrides)),
    ]),
  );
  expect(codes).toEqual({
    unknownDependency: 'invalid_policy',
    degradeField: 'invalid_policy',
    switchesField: 'invalid_policy',
    unknownNested: 'invalid_policy',
  });
});

it('[02 §14 登记范围] entry() 查未登记的依赖（如 payout.alipay）抛 invalid_policy', () => {
  const registry = createResilienceRegistry();
  expect(codeOf(() => registry.entry('payout.alipay' as never))).toBe('invalid_policy');
});
