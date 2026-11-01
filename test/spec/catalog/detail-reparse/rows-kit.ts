// B1-05w: the detail over real product_refs and pool_items rows (the int tests hand in the database,
// usePoolDatabase of the pool kit): real Catalog, real pool reader, the fake union of ./kit.ts. The
// fixture builds the reparser first, so on the skeleton every case stops at NotImplemented.
import { createCatalog } from '../../../../apps/api/src/modules/catalog/application/catalog.ts';
import { createRawReparser } from '../../../../apps/api/src/modules/catalog/application/raw-reparse.ts';
import {
  getProduct,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import { createKyselyPoolReader } from '../../../../apps/api/src/modules/catalog/infra/kysely-pool-reader.ts';
import { PRODUCT_KEY, fixture } from '../detail/kit.ts';
import {
  configOf,
  seedItem,
  seedPool,
  seedRef,
  secondsAgo,
  tenant,
  type PoolDatabase,
  type Tenant,
} from '../product-pool-read/kit.ts';
import { FRESH_MS, STORED_RAW, STORED_TITLE, unionFake } from './kit.ts';

export const STABLE = 'synthetic001';
/** Past step ②'s limit by a second: real rows hold whole instants. */
export const AGED_SEC = FRESH_MS / 1000 + 1;

type RefExtra = NonNullable<Parameters<typeof seedRef>[4]>;
type ItemExtra = NonNullable<Parameters<typeof seedItem>[5]>;

export async function rowsCase(h: PoolDatabase) {
  const base = fixture();
  const fake = unionFake();
  const owner = await tenant(h.db);
  const clock = base.clock;
  const catalog = createCatalog({ db: h.db, clock, warn: () => undefined });
  const reparser = createRawReparser({ union: fake.union, clock, catalog, redis: null });
  base.current.mockResolvedValue({
    appId: owner.appId,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  });
  const options: ProductDetailOptions = {
    ...base.options,
    catalog,
    poolReader: createKyselyPoolReader({ db: h.db, clock, config: configOf(new Map()) }),
    upstream: createUnionDetailUpstream({ union: fake.union, reparser }),
  };
  /** A stale product_refs row of the key; other columns as given. */
  const staleRef = (who: Tenant = owner, extra: RefExtra = {}) => {
    const aged = secondsAgo(clock, AGED_SEC);
    return seedRef(h.db, who, clock, STABLE, {
      raw_item_id: STORED_RAW,
      title: STORED_TITLE,
      raw_fetched_at: aged,
      refreshed_at: aged,
      ...extra,
    });
  };
  /** A pool of its own holding the key. */
  const poolRow = async (who: Tenant = owner, extra: ItemExtra = {}) => {
    const pool = await seedPool(h.db, who, clock);
    await seedItem(h.db, who, clock, pool, PRODUCT_KEY, extra);
    return pool;
  };
  const refRow = (who: Tenant = owner) =>
    h.db
      .selectFrom('product_refs')
      .selectAll()
      .where('app_id', '=', who.appId)
      .where('product_key', '=', PRODUCT_KEY)
      .executeTakeFirstOrThrow();
  return {
    ...fake,
    fake,
    clock,
    owner,
    rows: base.rows,
    staleRef,
    poolRow,
    refRow,
    other: () => tenant(h.db),
    run(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, ...query }, options);
    },
  };
}
