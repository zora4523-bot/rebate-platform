// Registry of external-dependency resilience (规划/02 §14 外部依赖与降级, §6.2 治理层, §1 原则 4):
// for every dependency row it holds the failure modes, the degrade action, the switch names, the
// module that carries out the degrade, and the governance policy (timeout, retries, breaker) that
// `createGovernor` of ../http/index.ts runs the calls with. The numbers can be overridden by
// configuration; the rows themselves (failure modes, degrade, switches, owner) cannot.
// The rule tests in test/spec/platform/resilience/** import this file by path; names, signatures
// and the semantics written here are the contract.
//
// Scope (task B1-14a): the non-fund, non-attribution rows of 规划/02 §14 — union search, 口令解析,
// 千问 (百炼), TypeSafe Jev, 内容安全, 短信, 推送. Not here: 转链 and 转链复核 (attribution
// path), 订单接口, 支付宝, 银行卡通道, 站长联盟授权, API 入口, PostgreSQL, Redis.
//
// Rows, in this order (`DependencyId`, owner module of 规划/02 §4.1):
//   union.search        catalog   timeout, rate_limited → stale_cache_or_error (50304, BR-PROD-07);
//                                 switches: none (自动，熔断)
//   union.tpwd_parse    parsing   permission_missing → guide_title_search (30132);
//                                 switches: parse.tpwd.enabled
//   model.qwen          agent     timeout, rate_limited, server_error, budget_exhausted →
//                                 backup_then_no_model (50302 only when keyword search also fails,
//                                 BR-AI-14 AI-05); switches: agent.model_route, agent.enabled
//   judge.jev           judge     timeout, rate_limited, server_error, budget_exhausted →
//                                 rules_only; switches: jev.enabled, agent.result_check.provider
//   content_safety      agent     timeout → fail_closed (BR-AI-18); switches: none (自动)
//   sms                 notification  channel_down → backup_provider; switches: sms.provider
//   push                notification  channel_down → inbox_fallback; switches: none (自动)
//
// Policies: the two union rows use `unionPolicy('online')` of ../http/index.ts (values are not
// repeated here). judge.jev: timeout 400 ms, no retry (BR-AI-14 hard timeout, one request per
// round). content_safety: timeout 1 000 ms, no retry (BR-AI-18 agent.safety.timeout_ms default;
// the limit covers the whole review). model.qwen: timeout not above 8 000 ms
// (agent.model_timeout_ms default) and no retry (failure moves to the backup snapshot, then to
// the no-model degrade). sms, push: any policy `createGovernor` accepts.
//
// Overrides: `createResilienceRegistry(overrides)` merges, per dependency, `timeoutMs` and any
// subset of `retries` / `breaker` fields over the defaults. It throws
// `GovernanceError('invalid_policy')` when an override names an unknown dependency, carries a
// field other than timeoutMs / retries / breaker (or unknown nested fields), or when the merged
// policy breaks a constraint written on the policy types of ../http/index.ts. Every call returns
// fresh objects: changing a returned entry never changes another registry or a later lookup.
//
// Rules for the implementation: this directory is also compiled by the `test` project — erasable
// syntax only, `import type` for type-only imports, `.ts` extensions, no NestJS, no
// `process.env`, no logging, no wall clock. Not exported from ../index.ts yet (B1-14b).
import type { BreakerPolicy, GovernancePolicy, RetryPolicy } from '../http/index.ts';

export type DependencyId =
  | 'union.search'
  | 'union.tpwd_parse'
  | 'model.qwen'
  | 'judge.jev'
  | 'content_safety'
  | 'sms'
  | 'push';

export type OwnerModule = 'catalog' | 'parsing' | 'agent' | 'judge' | 'notification';

export type FailureMode =
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'budget_exhausted'
  | 'permission_missing'
  | 'channel_down';

export type DegradeAction =
  | 'stale_cache_or_error'
  | 'guide_title_search'
  | 'backup_then_no_model'
  | 'rules_only'
  | 'fail_closed'
  | 'backup_provider'
  | 'inbox_fallback';

export interface DegradeSpec {
  readonly action: DegradeAction;
  /** Error code of contracts/error-codes.yaml the degrade ends in, or null when none. */
  readonly errorCode: number | null;
}

export interface ResilienceEntry {
  readonly dependency: DependencyId;
  readonly ownerModule: OwnerModule;
  readonly failureModes: readonly FailureMode[];
  readonly degrade: DegradeSpec;
  /** Switch names of 规划/02 §14; empty when the row says 自动. */
  readonly switches: readonly string[];
  readonly policy: GovernancePolicy;
}

export interface PolicyOverride {
  readonly timeoutMs?: number;
  readonly retries?: Partial<RetryPolicy>;
  readonly breaker?: Partial<BreakerPolicy>;
}

export type ResilienceOverrides = Readonly<Partial<Record<DependencyId, PolicyOverride>>>;

export interface ResilienceRegistry {
  /** All rows, in the order written above. */
  entries(): readonly ResilienceEntry[];
  /** One row; throws `GovernanceError('invalid_policy')` for an unknown id. */
  entry(dependency: DependencyId): ResilienceEntry;
}

export function createResilienceRegistry(overrides?: ResilienceOverrides): ResilienceRegistry {
  void overrides;
  throw new Error('NotImplemented: createResilienceRegistry');
}
