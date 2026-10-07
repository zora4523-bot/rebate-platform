import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  createCatalog,
  createItemRefService,
  GovernedUnion,
  RebateQuoter,
  SourceLinkReader,
  type Catalog,
  type CatalogWarning,
  type ItemRefService,
} from '../catalog/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type RootLogger,
} from '../platform/index.ts';
import { createParsing } from './application/parsing.ts';
import {
  PARSING_FACTORY,
  ParseInputController,
  type ParsingFactory,
} from './http/public/parse-input.controller.ts';
import { PARSING_ROUTE_PORTS, ParsingConfigReader, type ParsingRoutePorts } from './ports.ts';

/** Builds the configuration port; app.module.ts passes content's reader (F1-02b). */
export type ParsingConfigReaderFactory = (
  db: Kysely<Database>,
  clock: Clock,
) => ParsingConfigReader;

function unavailable(): Promise<never> {
  return Promise.reject(new Error('parsing: no database handle in this process'));
}

/** Entries built without database handles (isolated HTTP unit tests) fail at call time. */
const UNAVAILABLE_CONFIG: ParsingConfigReader = { configValue: unavailable };
const UNAVAILABLE_CATALOG: Pick<Catalog, 'listPlatforms' | 'resolveProductKey'> = {
  listPlatforms: unavailable,
  resolveProductKey: unavailable,
};

/** The item_ref cipher of a process; staging and prod always have the field keyring. */
export type ItemRefCipher = Pick<FieldCrypto, 'encrypt' | 'decrypt'>;

/**
 * The item_ref issuer of the route (BR-PROD-11): the field keyring, or in local / test without one
 * the per-process cipher app.module.ts passes; any other environment without a keyring refuses to
 * start (same rule as catalog's issuer).
 */
function itemRefIssuer(
  config: AppConfig,
  crypto: FieldCrypto | undefined,
  localCipher: (() => ItemRefCipher) | undefined,
): ItemRefService {
  if (crypto !== undefined) return createItemRefService({ crypto });
  if ((config.appEnv === 'local' || config.appEnv === 'test') && localCipher !== undefined) {
    return createItemRefService({ crypto: localCipher() });
  }
  throw new Error('parsing: item_ref needs the field keyring outside local / test');
}

/**
 * The route's ports, once per process. Catalog's reads are built here from the database handle
 * (catalog is stateless over it); the governed union adapters, the demo quoter and linking's
 * entry_source reader are app.module's global providers (B1-05j).
 */
function routePorts(
  options: ParsingModuleOptions,
  db: Kysely<Database> | undefined,
  clock: Clock,
  logger: RootLogger,
  config: AppConfig,
  union: GovernedUnion,
  quoter: RebateQuoter,
  sourceLinks: SourceLinkReader,
  crypto: FieldCrypto | undefined,
): ParsingRoutePorts {
  return {
    catalog:
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
    getGovernedAdapter: (platform) => union.adapter(platform),
    quoter,
    sourceLinks,
    itemRefs: itemRefIssuer(config, crypto, options.localItemRefCipher),
  };
}

/** What the composition root may pass besides the configuration port. */
export interface ParsingModuleOptions {
  /**
   * The parsing service factory of the route. app.module.ts passes the one exported by
   * parsing/index.ts, so the route builds its service through the module's public surface;
   * omitted, the module uses the same function directly.
   */
  readonly createParsing?: ParsingFactory;
  /**
   * The item_ref cipher of a local / test process started without the field keyring; app.module.ts
   * passes catalog's per-process cipher. Omitted, such a process refuses to start.
   */
  readonly localItemRefCipher?: () => ItemRefCipher;
}

/**
 * Parsing (规划/02 §4.1): B1-07a assembles the configuration port (content's cached reader, built
 * once per process by the factory app.module.ts passes), so parsing never imports content.
 * B1-07b adds the POST /v1/inputs/parse route and its ports; the parsing service itself
 * (createParsing) is built per request by the route, with catalog's card entry for the request's
 * viewer. The route needs app.module's global providers GovernedUnion, RebateQuoter,
 * SourceLinkReader (B1-05j) and ParsingLinkRegistrars (linking's per-request registration).
 */
@Module({})
export class ParsingModule {
  static forRoot(
    configReader: ParsingConfigReaderFactory,
    options: ParsingModuleOptions = {},
  ): DynamicModule {
    return {
      module: ParsingModule,
      controllers: [ParseInputController],
      providers: [
        {
          provide: ParsingConfigReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): ParsingConfigReader =>
            db === undefined ? UNAVAILABLE_CONFIG : configReader(db, clock),
        },
        { provide: PARSING_FACTORY, useValue: options.createParsing ?? createParsing },
        {
          provide: PARSING_ROUTE_PORTS,
          inject: [
            { token: DB, optional: true },
            CLOCK,
            ROOT_LOGGER,
            APP_CONFIG,
            GovernedUnion,
            RebateQuoter,
            SourceLinkReader,
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            logger: RootLogger,
            config: AppConfig,
            union: GovernedUnion,
            quoter: RebateQuoter,
            sourceLinks: SourceLinkReader,
            crypto?: FieldCrypto,
          ): ParsingRoutePorts =>
            routePorts(options, db, clock, logger, config, union, quoter, sourceLinks, crypto),
        },
      ],
      exports: [ParsingConfigReader],
    };
  }
}
