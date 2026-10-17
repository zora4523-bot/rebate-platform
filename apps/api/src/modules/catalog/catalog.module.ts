import type { DB as Database } from '@couli/db';
import { type DynamicModule, type FactoryProvider, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  REDIS,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { createUnionPidService, type UnionPidService } from '../union/index.ts';
import { createCatalogCardEntry } from './application/card-entry.ts';
import { createCatalog } from './application/catalog.ts';
import { CatalogDetailService } from './application/detail-service.ts';
import { createItemRefService, type ItemRefService } from './application/item-ref.ts';
import { CatalogSearchService } from './application/search-service.ts';
import { markFreshDetail, type ProductDetailUpstream } from './detail.ts';
import type { Catalog, CatalogWarning } from './domain/types.ts';
import {
  PRICE_TREND,
  PriceTrendController,
  type PriceTrendPorts,
} from './http/public/price-trend.controller.ts';
import { ProductController } from './http/public/product.controller.ts';
import { SearchController } from './http/public/search.controller.ts';
import { createUnionDetailUpstream } from './infra/detail-wiring.ts';
import { processItemRefCipher } from './infra/process-item-ref-cipher.ts';
import {
  PRODUCT_CACHE_NAMESPACE,
  cacheDetailUpstream,
  cacheSearchUpstream,
} from './infra/product-cache.ts';
import { keyringSearchCursorKey, processSearchCursorKey } from './infra/search-cursor.ts';
import {
  SEARCH_REDIS_NAMESPACE,
  UNAVAILABLE_SEARCH_SESSIONS,
  createRedisSearchSessionStore,
  createSearchCursorCodec,
  createUnionSearchUpstream,
} from './infra/search-wiring.ts';
import {
  CatalogConfigReader,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
  ViewerContext,
  createGuestViewerContext,
  type Viewer,
} from './ports.ts';
import type { SearchCursorCodec, SearchSessionStore, SearchUpstream } from './search.ts';
import { createPriceSnapshotRecorder } from './price-history/recorder.ts';
import { createKyselyPriceSnapshotStore } from './price-history/store.ts';
import { createKyselyPriceTrendStore } from './price-trend/store.ts';
import type { PriceTrendStore } from './price-trend/types.ts';
import type { PriceSnapshotRecorder, PriceSnapshotStore } from './price-history/types.ts';
import type { Logger } from 'pino';

/** Nest injection token of the Catalog service. */
export const CATALOG = Symbol('CATALOG');
/** Process-wide search ports: item_ref issuer, query-PID reader, session store, cursor codec. */
const ITEM_REFS = Symbol('CATALOG_ITEM_REFS');
const QUERY_PIDS = Symbol('CATALOG_QUERY_PIDS');
const SEARCH_SESSIONS = Symbol('CATALOG_SEARCH_SESSIONS');
const SEARCH_CURSORS = Symbol('CATALOG_SEARCH_CURSORS');
const PRICE_HISTORY = Symbol('CATALOG_PRICE_HISTORY');

type PidReader = Pick<UnionPidService, 'getActivePid'>;

/** The read-only active-pid query of union (B1-19b); writes are refused (same as linking). */
function pidReader(db: Kysely<Database>, clock: Clock): PidReader {
  const service = createUnionPidService({
    db,
    clock,
    superVerifier: { verify: () => Promise.resolve(null) },
    auditWriter: () => ({
      append: () => Promise.reject(new Error('catalog: union pid writes are not served here')),
    }),
  });
  return { getActivePid: (input) => service.getActivePid(input) };
}

/** Builds the configuration port; app.module.ts passes content's reader (F1-02b). */
export type CatalogConfigReaderFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => CatalogConfigReader;

function unavailable(): Promise<never> {
  return Promise.reject(new Error('catalog: no database handle in this process'));
}

/** Entries built without database handles (isolated HTTP unit tests) fail at call time. */
const UNAVAILABLE_CATALOG: Catalog = {
  listPlatforms: unavailable,
  requirePlatform: unavailable,
  resolveProductKey: unavailable,
  isSameProduct: unavailable,
  registerProductRef: unavailable,
  readProductRef: unavailable,
  takeRawItemId: unavailable,
  filterCategories: unavailable,
};

const UNAVAILABLE_CONFIG: CatalogConfigReader = { configValue: unavailable };
const UNAVAILABLE_PIDS: PidReader = { getActivePid: unavailable };
const UNAVAILABLE_PRICE_TREND: PriceTrendStore = { keyStability: unavailable, rows: unavailable };

/** Built on first read, not at startup: entries whose DB handle is a stand-in still start. */
function lazyPriceTrendStore(db: Kysely<Database>): PriceTrendStore {
  let store: PriceTrendStore | undefined;
  const get = (): PriceTrendStore => (store ??= createKyselyPriceTrendStore(db));
  return {
    keyStability: (platform) => get().keyStability(platform),
    rows: (query) => get().rows(query),
  };
}

/** A request without an app scope has no viewer at all: every read of it fails closed. */
class UnscopedViewerContext extends ViewerContext {
  current(): Promise<Viewer> {
    return Promise.reject(new Error('catalog: request carries no app scope'));
  }
}

interface ScopedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/** A port provider without its token: the module supplies its own abstract class as `provide`. */
export type CatalogPortProvider<T> = Omit<FactoryProvider<T>, 'provide'>;

/**
 * Optional port replacements (B1-02m): app.module.ts passes identity's request-scoped viewer on
 * the `api` entry. Absent, the default guest viewer below is kept unchanged.
 */
export interface CatalogPorts {
  readonly viewerContext?: CatalogPortProvider<ViewerContext>;
}

const GUEST_VIEWER: FactoryProvider<ViewerContext> = {
  provide: ViewerContext,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: ScopedRequest): ViewerContext => {
    const appId = request.headers?.['x-app-id'];
    return typeof appId === 'string' && appId !== ''
      ? createGuestViewerContext({ appId, deviceId: null })
      : new UnscopedViewerContext();
  },
};

/** B1-17c: what createPriceHistoryRecorder is built from. */
export interface PriceHistoryWiring {
  /** The single writer of price_snapshot: createKyselyPriceSnapshotStore(DB) in the modules. */
  readonly store: PriceSnapshotStore;
  readonly clock: Clock;
  /** price_snapshot.touch_min_interval_minutes is read through it (createPriceSnapshotRecorder). */
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * B1-17c: the price history recorder the modules hand to the three hooks (search, detail, quote;
 * BR-WATCH-19 (1)). It is createPriceSnapshotRecorder (B1-17b, reused, never copied: same skips,
 * same failure counting and warn, same drain) over `store` behind a concurrency cap: at most 2
 * store.write calls are in flight at any time, later writes wait in arrival order and start as
 * earlier ones settle (fulfilled or rejected). B1-17b followup: every write opens its own
 * transaction and queues on an advisory lock, so without the cap a burst of fresh union returns
 * could hold the API's whole pool. A queued write still counts for drain().
 * CatalogModule and ParsingModule build it from the DB handle (createKyselyPriceSnapshotStore),
 * CLOCK, their configuration reader and ROOT_LOGGER; without a DB handle they wire no recorder
 * and the three hooks stay off.
 */
export function createPriceHistoryRecorder(wiring: PriceHistoryWiring): PriceSnapshotRecorder {
  let active = 0;
  const waiting: (() => void)[] = [];
  const store: PriceSnapshotStore = {
    async write(input) {
      if (active >= 2) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await wiring.store.write(input);
      } finally {
        const next = waiting.shift();
        // Transfer the occupied slot directly to the oldest waiter, including on failure.
        if (next === undefined) active -= 1;
        else next();
      }
    },
  };
  return createPriceSnapshotRecorder({ ...wiring, store });
}

/** Mark only the union side: cache hits reconstruct pages/items without these markers. */
function freshSearchUpstream(upstream: SearchUpstream): SearchUpstream {
  return {
    search: async (input) => ({ ...(await upstream.search(input)), fresh: true }),
    materialFeed: async (input) => ({ ...(await upstream.materialFeed(input)), fresh: true }),
  };
}

function freshDetailUpstream(upstream: ProductDetailUpstream): ProductDetailUpstream {
  return { detail: async (input) => markFreshDetail(await upstream.detail(input)) };
}

/**
 * Catalog (规划/02 §4.1): platform dictionary, product_refs, aliases and the category blocklist.
 * Assembles two of its five ports here:
 * - ViewerContext: by default a guest of the request's app (X-App-Id, validated against the
 *   contract by the route schema), device unknown; the `api` entry passes identity's (B1-02m);
 * - CatalogConfigReader: built once per process by the factory app.module.ts passes (content's
 *   reader, F1-02b), so catalog never imports content.
 * B1-05j: GET /v1/products/search (SearchController → CatalogSearchService → searchProducts).
 * The service is request scoped (viewer) and uses LinkRegistrar, RebateQuoter, SourceLinkReader
 * and GovernedUnion from app.module's global providers; the item_ref issuer (FIELD_CRYPTO, or a
 * per-process key in local / test without a keyring), the query-PID reader, the Redis session
 * store and the cursor codec are built here once per process.
 * B1-05e: GET /v1/products/{product_key} (ProductController → CatalogDetailService → getProduct),
 * request scoped on the same ports and the same item_ref issuer; the union side is one getItem on
 * the governed adapter (infra/detail-wiring.ts).
 * B1-05g: both union upstreams sit behind the Redis search / detail cache (infra/product-cache.ts;
 * without REDIS they read the union directly); search sessions are written by compare-and-swap and
 * cursors are signed with the deployment key.
 * B1-29b: GET /v1/products/{product_key}/price-trend (PriceTrendController → getPriceTrend of
 * B1-29a over the read-only price_snapshot store, CLOCK and the configuration reader); separate
 * from the detail route, which never reads the trend.
 */
@Module({})
export class CatalogModule {
  static forRoot(configReader: CatalogConfigReaderFactory, ports?: CatalogPorts): DynamicModule {
    const viewerContext: FactoryProvider<ViewerContext> =
      ports?.viewerContext === undefined
        ? GUEST_VIEWER
        : { ...ports.viewerContext, provide: ViewerContext };
    return {
      module: CatalogModule,
      controllers: [SearchController, ProductController, PriceTrendController],
      providers: [
        {
          provide: CATALOG,
          inject: [{ token: DB, optional: true }, CLOCK, ROOT_LOGGER],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            logger: RootLogger,
          ): Catalog =>
            db === undefined
              ? UNAVAILABLE_CATALOG
              : createCatalog({
                  db,
                  clock,
                  warn: (event: CatalogWarning) => {
                    logger.warn(
                      { event: `catalog_${event.kind}`, product_key: event.key },
                      'product_key alias chain not resolved',
                    );
                  },
                }),
        },
        {
          provide: CatalogConfigReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): CatalogConfigReader =>
            db === undefined ? UNAVAILABLE_CONFIG : configReader(db, clock),
        },
        {
          // Singleton: all search and detail requests share the same two write slots.
          provide: PRICE_HISTORY,
          inject: [{ token: DB, optional: true }, CLOCK, CatalogConfigReader, ROOT_LOGGER],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            config: CatalogConfigReader,
            logger: RootLogger,
          ): PriceSnapshotRecorder | undefined =>
            db === undefined
              ? undefined
              : createPriceHistoryRecorder({
                  store: createKyselyPriceSnapshotStore(db),
                  clock,
                  config,
                  logger,
                }),
        },
        {
          provide: PRICE_TREND,
          inject: [{ token: DB, optional: true }, CATALOG, CLOCK, CatalogConfigReader],
          useFactory: (
            db: Kysely<Database> | undefined,
            catalog: Catalog,
            clock: Clock,
            config: CatalogConfigReader,
          ): PriceTrendPorts => ({
            catalog,
            options: {
              store: db === undefined ? UNAVAILABLE_PRICE_TREND : lazyPriceTrendStore(db),
              clock,
              config,
            },
          }),
        },
        viewerContext,
        {
          provide: ITEM_REFS,
          inject: [APP_CONFIG, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (config: AppConfig, crypto?: FieldCrypto): ItemRefService => {
            if (crypto !== undefined) return createItemRefService({ crypto });
            if (config.appEnv !== 'local' && config.appEnv !== 'test') {
              throw new Error('catalog: item_ref needs the field keyring outside local / test');
            }
            return createItemRefService({ crypto: processItemRefCipher() });
          },
        },
        {
          provide: QUERY_PIDS,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PidReader =>
            db === undefined ? UNAVAILABLE_PIDS : pidReader(db, clock),
        },
        {
          provide: SEARCH_SESSIONS,
          inject: [{ token: REDIS, optional: true }],
          useFactory: (redis?: RedisHandle): SearchSessionStore =>
            redis === undefined
              ? UNAVAILABLE_SEARCH_SESSIONS
              : createRedisSearchSessionStore(redis.namespace(SEARCH_REDIS_NAMESPACE)),
        },
        {
          // B1-05g ②: one signing key per deployment, never per module instance or process in
          // staging / prod: derived from the field keyring when there is one; local / test without
          // a keyring use the process-wide key; staging / prod without a keyring refuse to start.
          provide: SEARCH_CURSORS,
          inject: [APP_CONFIG, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (config: AppConfig, crypto?: FieldCrypto): SearchCursorCodec => {
            if (crypto !== undefined) {
              // Derived on first use, not at startup: only search touches the keyring for it.
              let codec: SearchCursorCodec | undefined;
              const signed = (): SearchCursorCodec =>
                (codec ??= createSearchCursorCodec(keyringSearchCursorKey(crypto)));
              return {
                encode: (value) => signed().encode(value),
                decode: (value) => signed().decode(value),
              };
            }
            if (config.appEnv !== 'local' && config.appEnv !== 'test') {
              throw new Error(
                'catalog: search cursors need the field keyring outside local / test',
              );
            }
            return createSearchCursorCodec(processSearchCursorKey());
          },
        },
        {
          provide: CatalogSearchService,
          scope: Scope.REQUEST,
          inject: [
            ViewerContext,
            CATALOG,
            CatalogConfigReader,
            CLOCK,
            ROOT_LOGGER,
            LinkRegistrar,
            RebateQuoter,
            SourceLinkReader,
            GovernedUnion,
            ITEM_REFS,
            QUERY_PIDS,
            SEARCH_SESSIONS,
            SEARCH_CURSORS,
            PRICE_HISTORY,
            { token: REDIS, optional: true },
          ],
          useFactory: (
            viewerContext: ViewerContext,
            catalog: Catalog,
            config: CatalogConfigReader,
            clock: Clock,
            logger: RootLogger,
            registrar: LinkRegistrar,
            quoter: RebateQuoter,
            sourceLinks: SourceLinkReader,
            union: GovernedUnion,
            itemRefs: ItemRefService,
            pids: PidReader,
            sessions: SearchSessionStore,
            cursors: SearchCursorCodec,
            priceHistory: PriceSnapshotRecorder | undefined,
            redis?: RedisHandle,
          ): CatalogSearchService =>
            new CatalogSearchService({
              clock,
              viewerContext,
              config,
              pids,
              catalog,
              cards: createCatalogCardEntry({
                clock,
                viewerContext,
                quoter,
                registrar,
                sourceLinks,
                itemRefs,
                logger,
              }),
              upstream: cacheSearchUpstream(
                freshSearchUpstream(
                  createUnionSearchUpstream({
                    union,
                    catalog,
                    config,
                    clock,
                    ledger: redis === undefined ? null : redis.namespace(SEARCH_REDIS_NAMESPACE),
                  }),
                ),
                {
                  redis: redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE),
                  clock,
                  config,
                },
              ),
              sessions,
              cursors,
              newSessionId: randomUUID,
              logger,
              ...(priceHistory === undefined ? {} : { priceHistory }),
            }),
        },
        {
          provide: CatalogDetailService,
          scope: Scope.REQUEST,
          inject: [
            ViewerContext,
            CATALOG,
            CatalogConfigReader,
            CLOCK,
            ROOT_LOGGER,
            LinkRegistrar,
            RebateQuoter,
            SourceLinkReader,
            GovernedUnion,
            ITEM_REFS,
            PRICE_HISTORY,
            { token: REDIS, optional: true },
          ],
          useFactory: (
            viewerContext: ViewerContext,
            catalog: Catalog,
            config: CatalogConfigReader,
            clock: Clock,
            logger: RootLogger,
            registrar: LinkRegistrar,
            quoter: RebateQuoter,
            sourceLinks: SourceLinkReader,
            union: GovernedUnion,
            itemRefs: ItemRefService,
            priceHistory: PriceSnapshotRecorder | undefined,
            redis?: RedisHandle,
          ): CatalogDetailService =>
            new CatalogDetailService({
              clock,
              viewerContext,
              config,
              catalog,
              itemRefs,
              cards: createCatalogCardEntry({
                clock,
                viewerContext,
                quoter,
                registrar,
                sourceLinks,
                itemRefs,
                logger,
              }),
              upstream: cacheDetailUpstream(
                freshDetailUpstream(createUnionDetailUpstream({ union })),
                {
                  redis: redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE),
                  clock,
                  config,
                },
              ),
              ...(priceHistory === undefined ? {} : { priceHistory }),
            }),
        },
      ],
      exports: [CATALOG, CatalogConfigReader, ViewerContext],
    };
  }
}
