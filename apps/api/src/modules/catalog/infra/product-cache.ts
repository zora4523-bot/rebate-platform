import type { Clock, RedisNamespace } from '../../platform/index.ts';
import type { ProductDetailUpstream } from '../detail.ts';
import type { CatalogConfigReader } from '../ports.ts';
import type { SearchUpstream } from '../search.ts';

/** Cache decorators retain the public use-case ports; callers still assemble each card. */
export interface ProductCacheOptions {
  readonly redis: RedisNamespace | null;
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
}

export function cacheSearchUpstream(
  upstream: SearchUpstream,
  options: ProductCacheOptions,
): SearchUpstream {
  void upstream;
  void options;
  throw new Error('NotImplemented: cacheSearchUpstream');
}

export function cacheDetailUpstream(
  upstream: ProductDetailUpstream,
  options: ProductCacheOptions,
): ProductDetailUpstream {
  void upstream;
  void options;
  throw new Error('NotImplemented: cacheDetailUpstream');
}
