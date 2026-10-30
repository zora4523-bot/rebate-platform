// B1-22v (编排裁定 D10-446 ①; 规划/02 §6.2 治理层; 架构评估 R-04): the union quota bucket shared
// by every process. Today each entry builds its own createMemoryQuotaLimiter, so the real
// upstream quota is multiplied by the number of processes. This limiter keeps the bucket in Redis
// instead: every process that passes the same namespace and the same bucket key takes from one
// bucket. The rule tests in test/spec/union/shared-quota/** import this file through
// platform/index.ts; the names, signatures and the semantics written here are the contract.
//
// createRedisQuotaLimiter(config, deps)
// - Validates `config` exactly as createMemoryQuotaLimiter does (same constraints, same
//   `GovernanceError('invalid_policy')`, thrown synchronously) before anything else. Building the
//   limiter sends nothing to Redis and arms no timer.
// - Same semantics as createMemoryQuotaLimiter (./index.ts "Quota details"): one bucket per
//   purpose; capacity floor(capacity × share / 100) whole tokens; starts full; refills
//   continuously at refillPerSecond × share / 100 tokens per second, never above its capacity;
//   `tryAcquire` takes one whole token; `online` takes from `pool_refresh` when its own bucket has
//   no whole token; no other purpose borrows. The arithmetic is exact (whole tokens, no floating
//   point drift): any sequence of calls at whole-millisecond instants gets exactly the answers the
//   memory limiter gives for the same sequence.
// - Shared: the state lives only in Redis, in `deps.redis` (a namespace of the entry's REDIS
//   handle), under keys derived from `config.bucketKey`. Limiters of any process with the same
//   namespace name and bucket key share one bucket; different bucket keys never share. Nothing is
//   kept in the process (no local tokens, no cache of the bucket).
// - Atomic: each `tryAcquire` is exactly one `deps.redis.eval` (one script does the refill, the
//   decision, the borrowing and the take), so concurrent calls of any number of processes never
//   grant more than the bucket holds. Every key the script writes gets the handle's TTL
//   (ARGV[1]); the TTL is at least the time an empty bucket needs to refill to full, so an expired
//   key is always a full bucket.
// - Time: `deps.clock.now()` in whole milliseconds (the process CLOCK; the same wall-time base in
//   every process), passed to the script. A bucket's time never moves backwards: a process whose
//   clock is behind gets no refill from that and cannot rewind the bucket for the others.
// - Fail closed (R-04): when `eval` rejects (RedisUnavailableError, RedisClosedError, a
//   validation error, a script error, anything) or answers something that is not the script's
//   answer, `tryAcquire` resolves `false`: it never rejects, never grants, does not retry and never
//   falls back to an in-process bucket. It then logs one warn line `quota_redis_unavailable` on
//   `deps.logger` with flat fields only: `bucket_key`, `purpose` and `reason` (the
//   RedisUnavailableError's `reason`, `unexpected_reply` for an unusable answer, else `error`) —
//   never the URL, a credential, the error message, the error object or a stack.
//
// Governor (./index.ts, same task): `QuotaLimiter.tryAcquire` may now return a boolean (the memory
// limiter, test stubs) or a promise. The governor awaits it before the attempt; `false` or a
// rejection fails the call with `GovernanceError('quota_exceeded')` (never the limiter's own
// error): the operation is not invoked, nothing is recorded in the breaker, nothing is retried.
// The union governance layer (union/application/governed-adapter.ts, B1-04w gateUpstream), the
// order-sync governed adapter and the worker runtime only pass the limiter on, so their results
// stay those of the governor. createMemoryQuotaLimiter stays synchronous (it returns a boolean;
// test/spec/platform/http/quota.test.ts drains it synchronously).
//
// Wiring (app.module.ts, same task): every union quota limiter of every entry that builds governed
// union adapters (api: GovernedUnion; stream: the Agent's business ports; worker: the order-sync
// quota port) is built with createRedisQuotaLimiter called through platform/index.ts (the wiring
// rule test spies on that export), once per registered platform endpoint when the governed
// adapters are assembled, with config { bucketKey: endpoint.quotaKey, capacity: 100,
// refillPerSecond: 10, shares: quotaShares('mvp') } (one constant in app.module; TODO CAP-TB-12,
// CAP-JD-12, CAP-PDD-12: only the numbers change after measurement), deps.redis = a namespace of
// the entry's REDIS handle, under one namespace name shared by every entry (each decision is one
// script in that namespace), deps.clock = the entry's CLOCK. With REDIS
// provided, createMemoryQuotaLimiter is never used for a union adapter. admin and payout build no
// governed union adapter (payout has no Redis). Note: OrdersModule.forWorker (orders.module.ts)
// does not inject REDIS today; the worker's quota port must reach the entry's handle another way.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with the `.ts` extension, no NestJS, no `process.env`; logging only through
// `deps.logger`; time only from `deps.clock`.
import type { Clock } from '../clock/index.ts';
import type { RootLogger } from '../logging/index.ts';
import type { RedisNamespace } from '../redis/index.ts';
import type { QuotaConfig, QuotaLimiter, QuotaPurpose } from './index.ts';

export interface RedisQuotaDeps {
  /** A namespace of the entry's REDIS handle; every process passes the same namespace name. */
  readonly redis: RedisNamespace;
  /** The process CLOCK: the shared bucket's time base. */
  readonly clock: Clock;
  /** Receives the `quota_redis_unavailable` warn lines. */
  readonly logger: RootLogger;
}

/** A limiter whose bucket lives in Redis; `tryAcquire` resolves, never rejects. */
export interface RedisQuotaLimiter extends QuotaLimiter {
  tryAcquire(purpose: QuotaPurpose): Promise<boolean>;
}

/** The shared Redis token bucket of `config.bucketKey` (see the contract above). */
export function createRedisQuotaLimiter(
  config: QuotaConfig,
  deps: RedisQuotaDeps,
): RedisQuotaLimiter {
  void config;
  void deps;
  throw new Error('NotImplemented: createRedisQuotaLimiter');
}
