// B1-22v, 编排裁定 D10-460 (on top of D10-446 ① and R-04, see ./redis-quota.ts): the union quota
// of an entry that has no REDIS handle. The rule tests in test/spec/union/shared-quota/** import
// this file through platform/index.ts; the names, signatures and the semantics written here are
// the contract.
//
// When the entry has a REDIS handle nothing here is used: every union limiter is the shared
// bucket (createRedisQuotaLimiter, ./redis-quota.ts) in every APP_ENV, and a Redis failure refuses
// (R-04, unchanged). Only when the entry has no REDIS handle (REDIS not configured: harnesses
// that build an entry or a runtime without Redis) does the entry take its union limiters from ONE
// createUnionQuotaFallback(deps) per entry (process):
//
// createUnionQuotaFallback({ appEnv, logger, scheduler })
// - mode: 'memory' when appEnv is 'local' or 'test'; 'refuse' when appEnv is 'staging' or 'prod'.
// - Building it logs exactly one warn line `union_quota_redis_absent` on `deps.logger` with the
//   flat fields `app_env` (deps.appEnv) and `mode` — never a URL, a connection detail or a
//   credential. Nothing else is ever logged by the fallback or its limiters (no line per limiter,
//   none per refusal). Building it arms no timer.
// - limiter(config) validates `config` exactly as createMemoryQuotaLimiter does (same
//   constraints, `GovernanceError('invalid_policy')` thrown synchronously) in both modes; the
//   limiter's `bucketKey` is `config.bucketKey`.
//   - 'memory': the semantics of createMemoryQuotaLimiter(config, deps.scheduler) — one bucket
//     per purpose, capacity floor(capacity × share / 100), starts full, refills continuously on
//     deps.scheduler, `online` borrows from `pool_refresh`. Each limiter is a bucket of this
//     process only.
//   - 'refuse': `tryAcquire` answers false for every purpose, every time (never throws, never
//     rejects); through the governor the call ends with `quota_exceeded` and the upstream is not
//     called.
//
// Startup (unchanged, pinned by the rule tests): loadConnectionConfig (platform/db) requires
// REDIS_URL for api / stream / admin / worker, so a staging or prod entry missing it does not
// start; the 'refuse' mode only guards an entry assembled without REDIS some other way.
//
// Wiring (app.module.ts, same task): an entry without REDIS that builds governed union adapters
// (api: GovernedUnion; stream: the Agent's business ports; worker: the order-sync quota port)
// calls createUnionQuotaFallback through platform/index.ts exactly once, with the entry's
// APP_CONFIG appEnv and ROOT_LOGGER, and takes every union limiter from its `limiter` (same
// config as the shared bucket: capacity 100, 10/s, quotaShares('mvp'), bucketKey =
// endpoint.quotaKey); it calls neither createRedisQuotaLimiter nor createMemoryQuotaLimiter for a
// union adapter. An entry with REDIS never calls createUnionQuotaFallback.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with the `.ts` extension, no NestJS, no `process.env`; logging only through
// `deps.logger`.
import type { AppEnv } from '../config/index.ts';
import type { RootLogger } from '../logging/index.ts';
import type { QuotaConfig, QuotaLimiter, Scheduler } from './index.ts';

/** 'memory' (local / test) or 'refuse' (staging / prod). */
export type UnionQuotaFallbackMode = 'memory' | 'refuse';

export interface UnionQuotaFallbackDeps {
  /** The entry's APP_ENV. */
  readonly appEnv: AppEnv;
  /** Receives the one `union_quota_redis_absent` warn line. */
  readonly logger: RootLogger;
  /** The memory buckets' time source ('memory' mode). */
  readonly scheduler: Scheduler;
}

/** One per entry without REDIS (see the contract above). */
export interface UnionQuotaFallback {
  readonly mode: UnionQuotaFallbackMode;
  limiter(config: QuotaConfig): QuotaLimiter;
}

/** The union quota of an entry that has no REDIS handle (see the contract above). */
export function createUnionQuotaFallback(deps: UnionQuotaFallbackDeps): UnionQuotaFallback {
  void deps;
  throw new Error('NotImplemented: createUnionQuotaFallback');
}
