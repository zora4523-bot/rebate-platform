// union's admin console routes (B1-22h): /admin/v1/union-pids (list, register, change a pending
// row, activate with the 花卷云 ignore screenshot, retire; BR-ATTR-02, BR-ATTR-28). app.module
// imports this module on the admin entry only; the api, stream and worker entries do not serve
// /admin/v1. Permission and step-up checks go through platform's AdminOperationGuard, which the
// admin module provides on the admin entry (union never imports admin). Each change and its audit
// row share one transaction: app.module passes `auditWriter` (admin's writer bound to a handle).
// The screenshot store is HjyIgnoreEvidenceStore (memory in local / test, fail-closed elsewhere
// until the private OSS adapter exists). Without a database (isolated HTTP unit tests) the routes
// still register and every call fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import { AdminUnionPids } from './application/admin-pids.ts';
import { AdminUnionPidsController } from './http/admin/union-pids.controller.ts';
import { HjyIgnoreEvidenceStore } from './infra/hjy-ignore-evidence-store.ts';

/** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
export type UnionAuditWriterFactory = (db: Kysely<Database>, clock: Clock) => AuditPort;

export interface UnionAdminOptions {
  readonly auditWriter: UnionAuditWriterFactory;
}

@Module({})
export class UnionAdminModule {
  static forAdmin(options: UnionAdminOptions): DynamicModule {
    return {
      module: UnionAdminModule,
      controllers: [AdminUnionPidsController],
      providers: [
        {
          provide: HjyIgnoreEvidenceStore,
          inject: [APP_CONFIG, ROOT_LOGGER],
          useFactory: (config: AppConfig, logger: RootLogger) =>
            new HjyIgnoreEvidenceStore({ appEnv: config.appEnv, logger }),
        },
        {
          provide: AdminUnionPids,
          inject: [CLOCK, HjyIgnoreEvidenceStore, { token: DB, optional: true }],
          useFactory: (
            clock: Clock,
            evidence: HjyIgnoreEvidenceStore,
            db?: Kysely<Database>,
          ): AdminUnionPids =>
            new AdminUnionPids({
              db,
              clock,
              evidence,
              auditWriter: (trx) => options.auditWriter(trx, clock),
            }),
        },
      ],
    };
  }
}
