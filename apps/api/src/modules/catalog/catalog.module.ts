import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module, Scope } from '@nestjs/common';
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
import { createItemRefService, type ItemRefService } from './application/item-ref.ts';
import { CatalogSearchService } from './application/search-service.ts';
import type { Catalog, CatalogWarning } from './domain/types.ts';
import { SearchController } from './http/public/search.controller.ts';
import {
  SEARCH_REDIS_NAMESPACE,
  UNAVAILABLE_SEARCH_SESSIONS,
  createProcessItemRefCipher,
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
import type { SearchCursorCodec, SearchSessionStore } from './search.ts';

/** Nest injection token of the Catalog service. */
export const CATALOG = Symbol('CATALOG');
/** Process-wide search ports: item_ref issuer, query-PID reader, session store, cursor codec. */
const ITEM_REFS = Symbol('CATALOG_ITEM_REFS');
const QUERY_PIDS = Symbol('CATALOG_QUERY_PIDS');
const SEARCH_SESSIONS = Symbol('CATALOG_SEARCH_SESSIONS');
const SEARCH_CURSORS = Symbol('CATALOG_SEARCH_CURSORS');

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

/** A request without an app scope has no viewer at all: every read of it fails closed. */
class UnscopedViewerContext extends ViewerContext {
  current(): Promise<Viewer> {
    return Promise.reject(new Error('catalog: request carries no app scope'));
  }
}

interface ScopedRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Catalog (规划/02 §4.1): platform dictionary, product_refs, aliases and the category blocklist.
 * Assembles two of its five ports here:
 * - ViewerContext: always a guest of the request's app (X-App-Id, validated against the contract
 *   by the route schema), device unknown, until identity replaces it (B1-02m);
 * - CatalogConfigReader: built once per process by the factory app.module.ts passes (content's
 *   reader, F1-02b), so catalog never imports content.
 * B1-05j: GET /v1/products/search (SearchController → CatalogSearchService → searchProducts).
 * The service is request scoped (viewer) and uses LinkRegistrar, RebateQuoter, SourceLinkReader
 * and GovernedUnion from app.module's global providers; the item_ref issuer (FIELD_CRYPTO, or a
 * per-process key in local / test without a keyring), the query-PID reader, the Redis session
 * store and the cursor codec are built here once per process.
 */
@Module({})
export class CatalogModule {
  static forRoot(configReader: CatalogConfigReaderFactory): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [SearchController],
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
          provide: ViewerContext,
          scope: Scope.REQUEST,
          inject: [REQUEST],
          useFactory: (request: ScopedRequest): ViewerContext => {
            const appId = request.headers?.['x-app-id'];
            return typeof appId === 'string' && appId !== ''
              ? createGuestViewerContext({ appId, deviceId: null })
              : new UnscopedViewerContext();
          },
        },
        {
          provide: ITEM_REFS,
          inject: [APP_CONFIG, { token: FIELD_CRYPTO, optional: true }],
          useFactory: (config: AppConfig, crypto?: FieldCrypto): ItemRefService => {
            if (crypto !== undefined) return createItemRefService({ crypto });
            if (config.appEnv !== 'local' && config.appEnv !== 'test') {
              throw new Error('catalog: item_ref needs the field keyring outside local / test');
            }
            return createItemRefService({ crypto: createProcessItemRefCipher() });
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
        { provide: SEARCH_CURSORS, useFactory: createSearchCursorCodec },
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
              upstream: createUnionSearchUpstream({
                union,
                catalog,
                config,
                clock,
                ledger: redis === undefined ? null : redis.namespace(SEARCH_REDIS_NAMESPACE),
              }),
              sessions,
              cursors,
              newSessionId: randomUUID,
              logger,
            }),
        },
      ],
      exports: [CATALOG, CatalogConfigReader, ViewerContext],
    };
  }
}
