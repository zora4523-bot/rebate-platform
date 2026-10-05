import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Kysely } from 'kysely';
import { CLOCK, DB, ROOT_LOGGER, type Clock, type RootLogger } from '../platform/index.ts';
import { createCatalog } from './application/catalog.ts';
import type { Catalog, CatalogWarning } from './domain/types.ts';
import {
  CatalogConfigReader,
  ViewerContext,
  createGuestViewerContext,
  type Viewer,
} from './ports.ts';

/** Nest injection token of the Catalog service. */
export const CATALOG = Symbol('CATALOG');

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
 * LinkRegistrar, SourceLinkReader (B1-06c) and RebateQuoter (B1-05f / B2-03) get their providers
 * with the services that use them.
 */
@Module({})
export class CatalogModule {
  static forRoot(configReader: CatalogConfigReaderFactory): DynamicModule {
    return {
      module: CatalogModule,
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
      ],
      exports: [CATALOG, CatalogConfigReader, ViewerContext],
    };
  }
}
