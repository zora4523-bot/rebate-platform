// union's admin console routes (B1-22h): /admin/v1/union-pids (list, register, change a pending
// row, activate with the 花卷云 ignore screenshot, retire; BR-ATTR-02, BR-ATTR-28); (B1-22d)
// /admin/v1/union-accounts (list, station-owner OAuth re-authorization sessions over B1-22c's
// createSiteReauth, manual credential entry; BR-ID-24 ③, D10-176, D10-196); (B1-22g)
// /admin/v1/union-accounts/alert-phones (list, add, remove the station-owner alert phones; the
// encrypted group is written only through content's createUnionAlertPhonesWriter inside union's
// transaction, with union's audit row; BR-ID-24 ②, D10-152 ④, D10-281); (B1-22o)
// /admin/v1/union/account-options (the PID form's account choices, union.pid or
// union.account_auth, read only; D10-243). app.module
// imports this module on the admin entry only; the api, stream and worker entries do not serve
// /admin/v1. Permission and step-up checks go through platform's AdminOperationGuard, which the
// admin module provides on the admin entry (union never imports admin). Each change and its audit
// row share one transaction: app.module passes `auditWriter` (admin's writer bound to a handle).
// The screenshot store is HjyIgnoreEvidenceStore (memory in local / test, fail-closed elsewhere
// until the private OSS adapter exists). The site OAuth providers are the local / test fake
// (infra/fake-site-oauth.ts); staging and prod get none (one warn) and an OAuth start fails closed
// until a union's site OAuth adapter exists. Without a database (isolated HTTP unit tests) or the
// field cipher the routes still register and every call fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { createUnionAlertPhonesWriter, type ContentReader } from '../content/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  ROOT_LOGGER,
  type AppConfig,
  type AuditPort,
  type Clock,
  type FieldCrypto,
  type RootLogger,
} from '../platform/index.ts';
import { AdminUnionAccountOptions } from './application/admin-account-options.ts';
import { AdminUnionAccounts, reauthAuditWriter } from './application/admin-accounts.ts';
import { AdminUnionAlertPhonesService } from './application/admin-alert-phones.ts';
import { AdminUnionPids } from './application/admin-pids.ts';
import { createSiteReauth } from './auth-expiry/reauth.ts';
import { AdminUnionAccountOptionsController } from './http/admin/union-account-options.controller.ts';
import { AdminUnionAccountsController } from './http/admin/union-accounts.controller.ts';
import { AdminUnionAlertPhonesController } from './http/admin/union-alert-phones.controller.ts';
import { AdminUnionPidsController } from './http/admin/union-pids.controller.ts';
import { createSiteOAuthProviders } from './infra/fake-site-oauth.ts';
import { HjyIgnoreEvidenceStore } from './infra/hjy-ignore-evidence-store.ts';

/** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
export type UnionAuditWriterFactory = (db: Kysely<Database>, clock: Clock) => AuditPort;

export interface UnionAdminOptions {
  readonly auditWriter: UnionAuditWriterFactory;
  /** content's configuration reader (attr.jd.user_key_mode, union.auth_alert_*). */
  readonly config: (db: Kysely<Database>, clock: Clock) => Pick<ContentReader, 'configValue'>;
}

@Module({})
export class UnionAdminModule {
  static forAdmin(options: UnionAdminOptions): DynamicModule {
    return {
      module: UnionAdminModule,
      controllers: [
        AdminUnionPidsController,
        AdminUnionAccountsController,
        AdminUnionAlertPhonesController,
        AdminUnionAccountOptionsController,
      ],
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
        {
          provide: AdminUnionAccounts,
          inject: [
            APP_CONFIG,
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            appConfig: AppConfig,
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminUnionAccounts => {
            const auditWriter = (trx: Kysely<Database>) => options.auditWriter(trx, clock);
            const reauth =
              db === undefined || crypto === undefined
                ? null
                : createSiteReauth({
                    db,
                    clock,
                    crypto,
                    // B1-22c's session audit rows under the contract's action names.
                    auditWriter: reauthAuditWriter(auditWriter),
                    config: options.config(db, clock),
                    oauth: createSiteOAuthProviders(appConfig.appEnv, clock, logger),
                  });
            return new AdminUnionAccounts({
              db,
              clock,
              crypto,
              config: options.config,
              auditWriter,
              reauth,
              logger,
            });
          },
        },
        {
          provide: AdminUnionAccountOptions,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): AdminUnionAccountOptions =>
            new AdminUnionAccountOptions({ db }),
        },
        {
          provide: AdminUnionAlertPhonesService,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminUnionAlertPhonesService =>
            new AdminUnionAlertPhonesService({
              db,
              clock,
              crypto,
              config: options.config,
              writer: createUnionAlertPhonesWriter({ clock, logger }),
              auditWriter: (trx) => options.auditWriter(trx, clock),
              logger,
            }),
        },
      ],
    };
  }
}
