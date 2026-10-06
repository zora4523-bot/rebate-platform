// Rule tests for the degrade registry of 规划/02 §14 外部依赖与降级 (non-fund, non-attribution rows:
// union search, 口令解析, 千问, TypeSafe Jev, 内容安全, 短信, 推送) and the timeouts fixed for them by
// 规划/02 §6.2 and 08 BR-AI-14 / BR-AI-18. The contract is the header of
// apps/api/src/modules/platform/resilience/index.ts. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  createGovernor,
  unionPolicy,
} from '../../../../apps/api/src/modules/platform/http/index.ts';
import {
  type DependencyId,
  type ResilienceEntry,
  createResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/resilience/index.ts';
import { expectedRows, rowOf, unionOnlineLiteral } from './kit.ts';

function entry(id: DependencyId): ResilienceEntry {
  return createResilienceRegistry().entry(id);
}

/** The row without its policy: what 规划/02 §14 writes in the four columns, plus the owner. */
function row(id: DependencyId): Omit<ResilienceEntry, 'policy'> {
  const { dependency, ownerModule, failureModes, degrade, switches } = entry(id);
  return { dependency, ownerModule, failureModes, degrade, switches };
}

it('[02 §14 登记范围] 登记表只含本段七行，顺序固定；资金、归属、订单补拉、数据库各行不在本表', () => {
  const ids = createResilienceRegistry()
    .entries()
    .map((e) => e.dependency);
  expect(ids).toEqual([
    'union.search',
    'union.tpwd_parse',
    'model.qwen',
    'judge.jev',
    'content_safety',
    'sms',
    'push',
  ]);
});

it('[02 §14 淘宝/京东/拼多多搜索] 超时、限流 → 有缓存读缓存标 stale，无缓存 50304（BR-PROD-07）；自动熔断，无开关；catalog 执行', () => {
  expect(row('union.search')).toEqual({
    dependency: 'union.search',
    ownerModule: 'catalog',
    failureModes: ['timeout', 'rate_limited'],
    degrade: { action: 'stale_cache_or_error', errorCode: 50304 },
    switches: [],
  });
});

it('[02 §14 口令解析权限未下] 30132 → 引导用商品名搜索；开关 parse.tpwd.enabled；parsing 执行', () => {
  expect(row('union.tpwd_parse')).toEqual({
    dependency: 'union.tpwd_parse',
    ownerModule: 'parsing',
    failureModes: ['permission_missing'],
    degrade: { action: 'guide_title_search', errorCode: 30132 },
    switches: ['parse.tpwd.enabled'],
  });
});

it('[02 §14 千问][BR-AI-14] 超时、429、5xx、预算用完 → 备用快照再无模型降级，搜索也失败才 50302；开关 agent.model_route、agent.enabled', () => {
  expect(row('model.qwen')).toEqual({
    dependency: 'model.qwen',
    ownerModule: 'agent',
    failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
    degrade: { action: 'backup_then_no_model', errorCode: 50302 },
    switches: ['agent.model_route', 'agent.enabled'],
  });
});

it('[02 §14 TypeSafe Jev][BR-AI-14] 超时、限流、失败、月用量触顶 → 回到纯规则核对，不出错误码；开关 jev.enabled、agent.result_check.provider；judge 执行', () => {
  expect(row('judge.jev')).toEqual({
    dependency: 'judge.jev',
    ownerModule: 'judge',
    failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
    degrade: { action: 'rules_only', errorCode: null },
    switches: ['jev.enabled', 'agent.result_check.provider'],
  });
});

it('[02 §14 内容安全][BR-AI-18] 超时 → fail-close（不放行），不出错误码；自动，无开关；agent 执行', () => {
  expect(row('content_safety')).toEqual({
    dependency: 'content_safety',
    ownerModule: 'agent',
    failureModes: ['timeout'],
    degrade: { action: 'fail_closed', errorCode: null },
    switches: [],
  });
});

it('[02 §14 短信] 通道故障 → 切备用通道；开关 sms.provider；notification 执行', () => {
  expect(row('sms')).toEqual({
    dependency: 'sms',
    ownerModule: 'notification',
    failureModes: ['channel_down'],
    degrade: { action: 'backup_provider', errorCode: null },
    switches: ['sms.provider'],
  });
});

it('[02 §14 推送] 通道故障 → 站内消息 + 回前台拉取兜底；自动，无开关；notification 执行', () => {
  expect(row('push')).toEqual({
    dependency: 'push',
    ownerModule: 'notification',
    failureModes: ['channel_down'],
    degrade: { action: 'inbox_fallback', errorCode: null },
    switches: [],
  });
});

it('[02 §6.2] 联盟两行（搜索、口令解析）的治理参数就是 02 §6.2 的在线值，与 unionPolicy(online) 一致', () => {
  const fromHttp = unionPolicy('online');
  const registry = createResilienceRegistry();
  expect({
    search: registry.entry('union.search').policy,
    tpwd: registry.entry('union.tpwd_parse').policy,
    fromHttp,
  }).toEqual({
    search: unionOnlineLiteral(),
    tpwd: unionOnlineLiteral(),
    fromHttp: unionOnlineLiteral(),
  });
});

it('[BR-AI-14][02 §9.2 结果核对] Jev 硬超时 400 毫秒，每轮只 1 次请求：不重试', () => {
  const { timeoutMs, retries } = entry('judge.jev').policy;
  expect({ timeoutMs, maxRetries: retries.maxRetries }).toEqual({ timeoutMs: 400, maxRetries: 0 });
});

it('[BR-AI-18] 内容安全审核超时默认 1000 毫秒（agent.safety.timeout_ms），整次审核共用这一时限：不重试', () => {
  const { timeoutMs, retries } = entry('content_safety').policy;
  expect({ timeoutMs, maxRetries: retries.maxRetries }).toEqual({
    timeoutMs: 1000,
    maxRetries: 0,
  });
});

it('[BR-AI-14] 千问单次调用不超过 agent.model_timeout_ms 默认 8000 毫秒；失败转备用快照，不对同一快照重试', () => {
  const { timeoutMs, retries } = entry('model.qwen').policy;
  expect({ withinRunLimit: timeoutMs <= 8000, maxRetries: retries.maxRetries }).toEqual({
    withinRunLimit: true,
    maxRetries: 0,
  });
});

it('[02 §1 原则 4] 每行的默认策略都能直接交给 createGovernor（不带病运行）', () => {
  const accepted = createResilienceRegistry()
    .entries()
    .map((e) => {
      try {
        createGovernor(e.dependency, e.policy);
        return [e.dependency, true] as const;
      } catch {
        return [e.dependency, false] as const;
      }
    });
  expect(accepted).toEqual([
    ['union.search', true],
    ['union.tpwd_parse', true],
    ['model.qwen', true],
    ['judge.jev', true],
    ['content_safety', true],
    ['sms', true],
    ['push', true],
  ]);
});

it('[02 §14 登记范围] entries() 与 entry(id) 给出同一行内容（对照手写的登记内容）', () => {
  const registry = createResilienceRegistry();
  expect({
    viaEntries: registry.entries().map(rowOf),
    viaEntry: expectedRows().map((r) => rowOf(registry.entry(r.dependency))),
  }).toEqual({ viaEntries: expectedRows(), viaEntry: expectedRows() });
});
