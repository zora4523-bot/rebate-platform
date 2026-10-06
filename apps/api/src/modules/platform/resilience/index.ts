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
import { createGovernor, GovernanceError, unionPolicy } from '../http/index.ts';

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

const ROWS: readonly Omit<ResilienceEntry, 'policy'>[] = [
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
];

function defaultPolicy(dependency: DependencyId): GovernancePolicy {
  const online = unionPolicy('online');
  if (dependency === 'union.search' || dependency === 'union.tpwd_parse') return online;

  // Where the spec does not fix thresholds, reuse the online breaker/backoff defaults.
  // SMS and push use its timeout too, with no automatic retry of channel writes.
  const timeoutMs =
    dependency === 'judge.jev'
      ? 400
      : dependency === 'content_safety'
        ? 1000
        : dependency === 'model.qwen'
          ? 8000
          : online.timeoutMs;
  return { ...online, timeoutMs, retries: { ...online.retries, maxRetries: 0 } };
}

function invalidPolicy(dependency: string): never {
  throw new GovernanceError('invalid_policy', dependency, 'Invalid resilience configuration');
}

/** Accept configuration records only, and snapshot own data fields without invoking getters. */
function fields(
  value: unknown,
  allowed: readonly string[],
  dependency: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidPolicy(dependency);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidPolicy(dependency);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return invalidPolicy(dependency);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return invalidPolicy(dependency);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function numericFields(
  value: unknown,
  allowed: readonly string[],
  dependency: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, number] of Object.entries(fields(value, allowed, dependency))) {
    if (typeof number !== 'number') return invalidPolicy(dependency);
    result[key] = number;
  }
  return result;
}

function mergePolicy(
  defaults: GovernancePolicy,
  override: unknown,
  dependency: DependencyId,
): GovernancePolicy {
  const values = fields(override, ['timeoutMs', 'retries', 'breaker'], dependency);
  let timeoutMs = defaults.timeoutMs;
  if (Object.hasOwn(values, 'timeoutMs')) {
    if (typeof values.timeoutMs !== 'number') return invalidPolicy(dependency);
    timeoutMs = values.timeoutMs;
  }
  return {
    timeoutMs,
    retries: {
      ...defaults.retries,
      ...(Object.hasOwn(values, 'retries')
        ? numericFields(values.retries, ['maxRetries', 'baseDelayMs', 'maxDelayMs'], dependency)
        : {}),
    },
    breaker: {
      ...defaults.breaker,
      ...(Object.hasOwn(values, 'breaker')
        ? numericFields(
            values.breaker,
            ['windowMs', 'minRequests', 'failureRatePercent', 'openMs'],
            dependency,
          )
        : {}),
    },
  };
}

function copyEntry(entry: ResilienceEntry): ResilienceEntry {
  return {
    ...entry,
    failureModes: [...entry.failureModes],
    degrade: { ...entry.degrade },
    switches: [...entry.switches],
    policy: {
      ...entry.policy,
      retries: { ...entry.policy.retries },
      breaker: { ...entry.policy.breaker },
    },
  };
}

export function createResilienceRegistry(overrides?: ResilienceOverrides): ResilienceRegistry {
  const configured = fields(
    overrides === undefined ? {} : overrides,
    ROWS.map((row) => row.dependency),
    'resilience',
  );
  const entries = new Map<DependencyId, ResilienceEntry>();
  for (const row of ROWS) {
    const defaults = defaultPolicy(row.dependency);
    const policy = Object.hasOwn(configured, row.dependency)
      ? mergePolicy(defaults, configured[row.dependency], row.dependency)
      : defaults;
    // Reuse the governor's numeric constraints. Construction starts no calls or timers.
    createGovernor(row.dependency, policy);
    entries.set(row.dependency, { ...row, policy });
  }
  return {
    entries: () => [...entries.values()].map(copyEntry),
    entry(dependency) {
      const entry = entries.get(dependency);
      if (entry === undefined) return invalidPolicy(dependency);
      return copyEntry(entry);
    },
  };
}
