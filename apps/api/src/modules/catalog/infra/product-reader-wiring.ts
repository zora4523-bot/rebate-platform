// B1-06j: production assembly of catalog's read-only product port — product_refs through
// catalog's own store, the union fallback through the governed adapters (one getItem, purpose
// online). app.module.ts hands the result to linking's landing card.
// B1-05g: the union fallback goes through the shared Redis detail cache (key app + product_key),
// so repeated opens of links to one product within the hit window call the union once.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  createCatalogProductReader,
  type CatalogProductReader,
} from '../application/product-reader.ts';
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';
import { createUnionDetailUpstream } from './detail-wiring.ts';
import { cacheDetailUpstream } from './product-cache.ts';
import { createKyselyCatalogStore } from './kysely-catalog-store.ts';

export function createDbCatalogProductReader(options: {
  readonly db: Kysely<DB>;
  readonly union: GovernedUnion;
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
  /** The PRODUCT_CACHE_NAMESPACE namespace; null (no REDIS) reads the union directly. */
  readonly cache: RedisNamespace | null;
}): CatalogProductReader {
  const store = createKyselyCatalogStore(options.db);
  return createCatalogProductReader({
    refs: {
      readProductRef: (appId, platform, productKey) =>
        store.readProductRef(appId, platform, productKey),
    },
    upstream: cacheDetailUpstream(createUnionDetailUpstream({ union: options.union }), {
      redis: options.cache,
      clock: options.clock,
      config: options.config,
    }),
    config: options.config,
  });
}
