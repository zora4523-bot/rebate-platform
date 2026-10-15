// content's admin console routes (F1-06w): GET /admin/v1/platform-icons and its version history.
// app.module imports this module on the admin entry only; the api and stream entries do not
// serve /admin/v1. Permission checks go through platform's AdminOperationGuard, which the admin
// module provides globally on the admin entry (content never imports admin).
// Reads use the primary handle DB (couli_app); DB_READ is deliberately not used. Without a
// database handle (isolated HTTP unit tests) the routes still register and every read fails
// closed (50001). Version urls use MEDIA_PUBLIC_BASE_URL as configured (no local default here),
// so staging / prod without it answer 50001 per request that carries a version.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { APP_CONFIG, DB, type AppConfig } from '../platform/index.ts';
import { PlatformIconReader, type PlatformIconStore } from './application/platform-icon-reader.ts';
import { AdminPlatformIconsController } from './http/admin/platform-icons.controller.ts';
import { createKyselyPlatformIconStore } from './infra/kysely-platform-icon-store.ts';

const refuse = (): Promise<never> =>
  Promise.reject(new Error('content: platform icon reads need the database'));

const NO_DATABASE: PlatformIconStore = {
  icons: refuse,
  latestVersions: refuse,
  versionPage: refuse,
};

@Module({})
export class ContentAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: ContentAdminModule,
      controllers: [AdminPlatformIconsController],
      providers: [
        {
          provide: PlatformIconReader,
          inject: [APP_CONFIG, { token: DB, optional: true }],
          useFactory: (config: AppConfig, db?: Kysely<Database>): PlatformIconReader =>
            new PlatformIconReader(
              db === undefined ? NO_DATABASE : createKyselyPlatformIconStore(db),
              config.mediaPublicBaseUrl,
            ),
        },
      ],
    };
  }
}
