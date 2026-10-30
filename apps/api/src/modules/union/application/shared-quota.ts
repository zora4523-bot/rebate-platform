// B1-22v (编排裁定 D10-446 ①; 规划/02 §6.2 治理层; 架构评估 R-04): the quota bucket of one union
// endpoint, shared by every process. The numbers (capacity, rate, shares) come from the caller
// (app.module keeps them in one constant); this file owns only the Redis namespace the buckets
// live in, so api, stream and worker take from the same bucket per endpoint.quotaKey (app ×
// platform). Building one sends nothing to Redis.
// - With the entry's REDIS handle: platform's createRedisQuotaLimiter (called through
//   platform/index.ts) over UNION_QUOTA_NAMESPACE, on the entry's CLOCK.
// - Without one (only isolated tests: api / stream / worker always carry REDIS_URL): fail-closed,
//   every token is refused with the warn line an unreachable Redis writes
//   (`quota_redis_unavailable`, reason `no_redis`); never an in-process bucket.
import {
  createRedisQuotaLimiter,
  type Clock,
  type QuotaConfig,
  type QuotaLimiter,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';

/** Redis namespace of the union quota buckets; the same name in every entry. */
export const UNION_QUOTA_NAMESPACE = 'union_quota';

export interface UnionQuotaDeps {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** The entry's REDIS handle; absent → every token is refused. */
  readonly redis: RedisHandle | undefined;
}

/** The shared quota bucket of `config.bucketKey` (endpoint.quotaKey). */
export function createSharedUnionQuota(config: QuotaConfig, deps: UnionQuotaDeps): QuotaLimiter {
  const { redis, clock, logger } = deps;
  if (redis === undefined) {
    const bucketKey = config.bucketKey;
    return {
      bucketKey,
      tryAcquire(purpose) {
        logger.warn(
          { bucket_key: bucketKey, purpose, reason: 'no_redis' },
          'quota_redis_unavailable',
        );
        return Promise.resolve(false);
      },
    };
  }
  return createRedisQuotaLimiter(config, {
    redis: redis.namespace(UNION_QUOTA_NAMESPACE),
    clock,
    logger,
  });
}
