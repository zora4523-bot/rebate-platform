// B1-22v (编排裁定 D10-446 ①, D10-460; 规划/02 §6.2 治理层; 架构评估 R-04): the quota bucket of one
// union endpoint. The numbers (capacity, rate, shares) come from the caller (app.module keeps them
// in one constant); this file owns only where the buckets live. One source per entry (process):
// - With the entry's REDIS handle: platform's createRedisQuotaLimiter (called through
//   platform/index.ts) over UNION_QUOTA_NAMESPACE, on the entry's CLOCK — api, stream and worker
//   take from the same bucket per endpoint.quotaKey (app × platform); a Redis failure refuses
//   (R-04). Building one sends nothing to Redis.
// - Without one (REDIS not configured; staging / prod do not start without REDIS_URL): every
//   limiter of the entry comes from ONE platform createUnionQuotaFallback (called through
//   platform/index.ts), built on the first such limiter — in-process buckets in local / test,
//   every token refused in staging / prod; it logs its own single warn line.
import {
  createRedisQuotaLimiter,
  createUnionQuotaFallback,
  systemScheduler,
  type AppEnv,
  type Clock,
  type QuotaConfig,
  type QuotaLimiter,
  type RedisHandle,
  type RootLogger,
  type UnionQuotaFallback,
} from '../../platform/index.ts';

/** Redis namespace of the union quota buckets; the same name in every entry. */
export const UNION_QUOTA_NAMESPACE = 'union_quota';

export interface UnionQuotaDeps {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** The entry's REDIS handle; absent → the entry's fallback (see above). */
  readonly redis: RedisHandle | undefined;
}

/** The union quota buckets of one entry; build exactly one per entry. */
export interface UnionQuotaSource {
  /** The bucket of `config.bucketKey` (endpoint.quotaKey). */
  limiter(config: QuotaConfig, deps: UnionQuotaDeps): QuotaLimiter;
}

/** One entry's union quota source; `appEnv` is the entry's APP_CONFIG appEnv. */
export function createUnionQuotaSource(appEnv: AppEnv): UnionQuotaSource {
  let fallback: UnionQuotaFallback | undefined;
  return {
    limiter(config, deps) {
      const { redis, clock, logger } = deps;
      if (redis === undefined) {
        fallback ??= createUnionQuotaFallback({ appEnv, logger, scheduler: systemScheduler() });
        return fallback.limiter(config);
      }
      return createRedisQuotaLimiter(config, {
        redis: redis.namespace(UNION_QUOTA_NAMESPACE),
        clock,
        logger,
      });
    },
  };
}
