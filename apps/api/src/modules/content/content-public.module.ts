// content's /v1 client routes (task F1-02c): GET /v1/config. app.module imports this module on
// the api entry only and passes identity's request viewer as the ConfigViewerContext provider
// (content never imports identity). Reads go through one process-wide ContentReader on the
// primary handle DB; without a database handle (isolated HTTP unit tests) the route still
// registers and every request fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  getLinkPatterns,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import { ClientConfigService, ConfigViewerContext } from './application/client-config.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { publishedPlatformIcons } from './application/published-platform-icons.ts';
import type { ClientConfig } from './domain/client-config.ts';
import { ConfigController } from './http/public/config.controller.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';

const UNAVAILABLE_READER: ContentReader = {
  minSupportedVersion: () => Promise.reject(new Error('content: config reads need the database')),
  configValue: () => Promise.reject(new Error('content: config reads need the database')),
};

export interface ContentPublicPorts {
  /** Request-scoped provider of the caller (identity's viewer on the api entry). */
  readonly viewerContext: Omit<FactoryProvider<ConfigViewerContext>, 'provide'>;
}

@Module({})
export class ContentPublicModule {
  static forApi(ports: ContentPublicPorts): DynamicModule {
    return {
      module: ContentPublicModule,
      controllers: [ConfigController],
      providers: [
        {
          provide: ClientConfigService,
          inject: [{ token: DB, optional: true }, CLOCK, ROOT_LOGGER, APP_CONFIG],
          useFactory: (
            db: Kysely<Database> | undefined,
            clock: Clock,
            logger: RootLogger,
            config: AppConfig,
          ): ClientConfigService =>
            new ClientConfigService({
              reader:
                db === undefined
                  ? UNAVAILABLE_READER
                  : new CachedContentReader(createKyselyContentStore(db), clock),
              platformIcons: (appId) => {
                if (db === undefined) {
                  return Promise.reject(
                    new Error('content: platform icon reads need the database'),
                  );
                }
                return publishedPlatformIcons(
                  { db, mediaPublicBaseUrl: config.mediaPublicBaseUrl },
                  appId,
                );
              },
              linkPatterns: () => getLinkPatterns() as NonNullable<ClientConfig['link_patterns']>,
              logger: logger.child({ module: 'content' }),
            }),
        },
        { ...ports.viewerContext, provide: ConfigViewerContext },
      ],
    };
  }
}
