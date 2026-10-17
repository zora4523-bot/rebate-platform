// content's /v1 client routes (F1-02c, F1-02e, F1-02f, F1-09d, F1-09e): config, app-versions
// check, articles, pages and the draft page preview (token only, no viewer context).
// app.module imports this module on
// the api entry only and passes identity's request viewer as the ConfigViewerContext provider
// (content never imports identity). Config reads use a process-wide ContentReader; article reads
// always query the primary handle DB afresh; page reads cache the page pointer and version rows
// (F1-09d) and filter per request. app.module may hand in the ContentReader so the version check
// shares one cache with risk's minimum-version gate (F1-02e followup). Without a database handle the routes still
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
  getMaterialChannels,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import { ClientConfigService, ConfigViewerContext } from './application/client-config.ts';
import { ArticleReader } from './application/article-reader.ts';
import { AppVersionCheckService } from './application/app-version-check.ts';
import { CachedContentReader, type ContentReader } from './application/content-reader.ts';
import { publishedPlatformIcons } from './application/published-platform-icons.ts';
import type { ClientConfig } from './domain/client-config.ts';
import { ConfigController } from './http/public/config.controller.ts';
import { ArticlesController } from './http/public/articles.controller.ts';
import { createKyselyArticleStore } from './infra/kysely-article-store.ts';
import { AppVersionsController } from './http/public/app-versions.controller.ts';
import { createKyselyContentStore } from './infra/kysely-content-store.ts';
import { PageReader } from './application/page-reader.ts';
import { PagesController } from './http/public/pages.controller.ts';
import { createKyselyPageStore } from './infra/kysely-page-store.ts';
import { PagePreviewService, type PagePreviewStore } from './application/page-preview.ts';
import { PagePreviewController } from './http/public/page-preview.controller.ts';
import { createKyselyPagePreviewStore } from './infra/kysely-page-preview-store.ts';

const UNAVAILABLE_READER: ContentReader = {
  appVersion: () => Promise.reject(new Error('content: version reads need the database')),
  minSupportedVersion: () => Promise.reject(new Error('content: config reads need the database')),
  configValue: () => Promise.reject(new Error('content: config reads need the database')),
};

const UNAVAILABLE_PREVIEWS: PagePreviewStore = {
  transaction: () => Promise.reject(new Error('content: preview tokens are not issued here')),
  consume: () => Promise.reject(new Error('content: page previews need the database')),
  sections: () => Promise.reject(new Error('content: page previews need the database')),
};

const CONTENT_READER = Symbol('CONTENT_READER');
const CONTENT_READER_SOURCE = Symbol('CONTENT_READER_SOURCE');

export interface ContentPublicPorts {
  /** Request-scoped provider of the caller (identity's viewer on the api entry). */
  readonly viewerContext: Omit<FactoryProvider<ConfigViewerContext>, 'provide'>;
  /**
   * The process-wide reader of config_items and app_versions (null: no database handle). When
   * absent the module builds its own over DB.
   */
  readonly contentReader?: Omit<FactoryProvider<ContentReader | null>, 'provide'>;
}

function ownContentReader(db: Kysely<Database> | undefined, clock: Clock): ContentReader | null {
  if (db === undefined) return null;
  const store = createKyselyContentStore(db);
  return new CachedContentReader(store, clock, store);
}

@Module({})
export class ContentPublicModule {
  static forApi(ports: ContentPublicPorts): DynamicModule {
    return {
      module: ContentPublicModule,
      controllers: [
        ConfigController,
        ArticlesController,
        AppVersionsController,
        PagesController,
        PagePreviewController,
      ],
      providers: [
        {
          // F1-09e previewPage: always the primary handle, never cached.
          provide: PagePreviewService,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PagePreviewService =>
            new PagePreviewService({
              store:
                db === undefined ? UNAVAILABLE_PREVIEWS : createKyselyPagePreviewStore(db, null),
              clock,
            }),
        },
        {
          provide: ArticleReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): ArticleReader =>
            new ArticleReader(db === undefined ? null : createKyselyArticleStore(db), clock),
        },
        {
          provide: PageReader,
          inject: [{ token: DB, optional: true }, CLOCK],
          useFactory: (db: Kysely<Database> | undefined, clock: Clock): PageReader =>
            new PageReader(db === undefined ? null : createKyselyPageStore(db), clock),
        },
        {
          provide: CONTENT_READER_SOURCE,
          ...(ports.contentReader ?? {
            inject: [{ token: DB, optional: true }, CLOCK],
            useFactory: ownContentReader,
          }),
        },
        {
          provide: CONTENT_READER,
          inject: [CONTENT_READER_SOURCE],
          useFactory: (reader: ContentReader | null): ContentReader => reader ?? UNAVAILABLE_READER,
        },
        {
          provide: ClientConfigService,
          inject: [CONTENT_READER, { token: DB, optional: true }, ROOT_LOGGER, APP_CONFIG],
          useFactory: (
            reader: ContentReader,
            db: Kysely<Database> | undefined,
            logger: RootLogger,
            config: AppConfig,
          ): ClientConfigService =>
            new ClientConfigService({
              reader,
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
              materialChannels: getMaterialChannels,
              logger: logger.child({ module: 'content' }),
            }),
        },
        {
          provide: AppVersionCheckService,
          inject: [CONTENT_READER, ROOT_LOGGER],
          useFactory: (reader: ContentReader, logger: RootLogger): AppVersionCheckService =>
            new AppVersionCheckService(reader, logger.child({ module: 'content' })),
        },
        { ...ports.viewerContext, provide: ConfigViewerContext },
      ],
    };
  }
}
