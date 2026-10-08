// B1-06j: production assembly of catalog's read-only product port — product_refs through
// catalog's own store, the union fallback through the governed adapters (one getItem, purpose
// online). app.module.ts hands the result to linking's landing card.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  createCatalogProductReader,
  type CatalogProductReader,
} from '../application/product-reader.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';
import { createUnionDetailUpstream } from './detail-wiring.ts';
import { createKyselyCatalogStore } from './kysely-catalog-store.ts';

export function createDbCatalogProductReader(options: {
  readonly db: Kysely<DB>;
  readonly union: GovernedUnion;
  readonly config: CatalogConfigReader;
}): CatalogProductReader {
  const store = createKyselyCatalogStore(options.db);
  return createCatalogProductReader({
    refs: {
      readProductRef: (appId, platform, productKey) =>
        store.readProductRef(appId, platform, productKey),
    },
    upstream: createUnionDetailUpstream({ union: options.union }),
    config: options.config,
  });
}
