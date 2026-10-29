// B1-28h: cache of the hot-sales list union side (规划/01 F-PROD-13 ⑥): answers are cached per
// (platform, channel, category, page) for rank.cache_ttl_seconds; on a union failure an existing
// entry is read, without one the failure propagates (the use case answers 50304).
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import type { HotRankUpstream } from '../hot-rank.ts';
import type { CatalogConfigReader } from '../ports.ts';

export interface HotRankCacheOptions {
  readonly redis: RedisNamespace | null;
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
}

export function cacheHotRankUpstream(
  upstream: HotRankUpstream,
  options: HotRankCacheOptions,
): HotRankUpstream {
  void upstream;
  void options;
  throw new Error('NotImplemented: cacheHotRankUpstream');
}
