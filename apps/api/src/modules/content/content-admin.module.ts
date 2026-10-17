// content's admin console routes: GET /admin/v1/platform-icons and its version history (F1-06w);
// registration, publish / rollback and restore-builtin (F1-06y); upload and save as version
// (F1-06x), whose cleaned files go to platform's MEDIA_STORE (provided globally by PlatformModule).
// app.module imports this module on the admin entry only; the api and stream entries do not
// serve /admin/v1. Permission checks go through platform's AdminOperationGuard, which the admin
// module provides globally on the admin entry (content never imports admin).
// Reads use the primary handle DB (couli_app); DB_READ is deliberately not used. Without a
// database handle (isolated HTTP unit tests) the routes still register and every read fails
// closed (50001). Version urls use MEDIA_PUBLIC_BASE_URL as configured (no local default here),
// so staging / prod without it answer 50001 per request that carries a version.
// Writes append their audit row on their own transaction: app.module passes `auditWriter`, which
// binds admin's audit writer (the single writer of audit_logs) to a transaction handle; content
// never imports admin.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  MEDIA_STORE,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type MediaStore,
} from '../platform/index.ts';
import {
  PlatformIconUploader,
  type PlatformIconUploadStore,
} from './application/platform-icon-uploader.ts';
import { PlatformIconReader, type PlatformIconStore } from './application/platform-icon-reader.ts';
import {
  PlatformIconWriter,
  type PlatformIconWriteStore,
} from './application/platform-icon-writer.ts';
import { AdminPlatformIconsController } from './http/admin/platform-icons.controller.ts';
import {
  createKyselyPlatformIconStore,
  createKyselyPlatformIconUploadStore,
  createKyselyPlatformIconWriteStore,
} from './infra/kysely-platform-icon-store.ts';
import { KillSwitchAdmin, type KillSwitchStore } from './application/kill-switch-admin.ts';
import { AdminKillSwitchesController } from './http/admin/kill-switches.controller.ts';
import { createKyselyKillSwitchStore } from './infra/kysely-kill-switch-store.ts';

/** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
export type ContentAuditWriterFactory = (db: Kysely<Database>, clock: Clock) => AuditPort;

export interface ContentAdminOptions {
  readonly auditWriter: ContentAuditWriterFactory;
}

const refuse = (): Promise<never> =>
  Promise.reject(new Error('content: platform icon reads need the database'));

const NO_DATABASE: PlatformIconStore = {
  icons: refuse,
  latestVersions: refuse,
  versionPage: refuse,
};

const NO_DATABASE_WRITES: PlatformIconWriteStore = {
  transaction: () => Promise.reject(new Error('content: platform icon writes need the database')),
};

const NO_DATABASE_UPLOADS: PlatformIconUploadStore = {
  configValue: () => Promise.reject(new Error('content: platform icon uploads need the database')),
  insertUpload: () => Promise.reject(new Error('content: platform icon uploads need the database')),
};

const NO_DATABASE_SWITCHES: KillSwitchStore = {
  rows: () => Promise.reject(new Error('content: kill switch reads need the database')),
  transaction: () => Promise.reject(new Error('content: kill switch writes need the database')),
};

/** Monotonic milliseconds for the SVG conversion budget (not business time). */
const monotonicMs = (): number => performance.now();

@Module({})
export class ContentAdminModule {
  static forAdmin(options: ContentAdminOptions): DynamicModule {
    return {
      module: ContentAdminModule,
      controllers: [AdminPlatformIconsController, AdminKillSwitchesController],
      providers: [
        {
          provide: KillSwitchAdmin,
          inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }],
          useFactory: (clock: Clock, logger: Logger, db?: Kysely<Database>): KillSwitchAdmin =>
            new KillSwitchAdmin(
              db === undefined
                ? NO_DATABASE_SWITCHES
                : createKyselyKillSwitchStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              logger,
            ),
        },
        {
          provide: PlatformIconReader,
          inject: [APP_CONFIG, { token: DB, optional: true }],
          useFactory: (config: AppConfig, db?: Kysely<Database>): PlatformIconReader =>
            new PlatformIconReader(
              db === undefined ? NO_DATABASE : createKyselyPlatformIconStore(db),
              config.mediaPublicBaseUrl,
            ),
        },
        {
          provide: PlatformIconWriter,
          inject: [APP_CONFIG, CLOCK, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            db?: Kysely<Database>,
          ): PlatformIconWriter =>
            new PlatformIconWriter(
              db === undefined
                ? NO_DATABASE_WRITES
                : createKyselyPlatformIconWriteStore(db, (trx) => options.auditWriter(trx, clock)),
              clock,
              config.mediaPublicBaseUrl,
            ),
        },
        {
          provide: PlatformIconUploader,
          inject: [APP_CONFIG, CLOCK, MEDIA_STORE, { token: DB, optional: true }],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            media: MediaStore,
            db?: Kysely<Database>,
          ): PlatformIconUploader =>
            new PlatformIconUploader({
              store:
                db === undefined ? NO_DATABASE_UPLOADS : createKyselyPlatformIconUploadStore(db),
              media,
              clock,
              mediaPublicBaseUrl: config.mediaPublicBaseUrl,
              newId: randomUUID,
              monotonicMs,
            }),
        },
      ],
    };
  }
}
