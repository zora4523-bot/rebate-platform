// identity's admin user list / lookup / detail (F1-07b) and reveal (F1-07a; BR-ID-33).
// app.module imports this module on the admin entry only; the api and stream entries do not
// serve /admin/v1. Permission and step-up checks go through platform's AdminOperationGuard,
// which the admin module provides on the admin entry (identity never imports admin); the audit
// row goes through platform's AUDIT_PORT, provided globally by the admin module.
// Without a database or field cipher (isolated HTTP unit tests) the route still registers and
// every reveal fails closed (50001).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AUDIT_PORT,
  DB,
  FIELD_CRYPTO,
  type AuditPort,
  type FieldCrypto,
} from '../platform/index.ts';
import { AdminUserReveal, type AdminRevealStore } from './application/admin-user-reveal.ts';
import { AdminUserRevealController } from './http/admin/user-reveal.controller.ts';
import { createKyselyAdminRevealStore } from './infra/admin-user-reads.ts';
import { AdminUsers } from './application/admin-users.ts';
import { AdminUsersController } from './http/admin/users.controller.ts';
import { createKyselyAdminUsersReader } from './infra/admin-user-view-reader.ts';

const NO_DATABASE: AdminRevealStore = {
  phoneCipher: () => Promise.reject(new Error('identity: user reveal needs the database')),
};

@Module({})
export class IdentityAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: IdentityAdminModule,
      controllers: [AdminUserRevealController, AdminUsersController],
      providers: [
        {
          provide: AdminUsers,
          inject: [
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (db?: Kysely<Database>, crypto?: FieldCrypto): AdminUsers =>
            new AdminUsers(
              db === undefined ? null : createKyselyAdminUsersReader(db, crypto ?? null),
              crypto ?? null,
            ),
        },
        {
          provide: AdminUserReveal,
          inject: [
            AUDIT_PORT,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            audit: AuditPort,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminUserReveal =>
            new AdminUserReveal({
              store: db === undefined ? NO_DATABASE : createKyselyAdminRevealStore(db),
              crypto: crypto ?? null,
              audit,
            }),
        },
      ],
    };
  }
}
