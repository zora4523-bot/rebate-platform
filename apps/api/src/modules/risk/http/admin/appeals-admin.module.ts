// risk's appeal console reads (B1-03zd, CT-24r): GET /admin/v1/appeals, /admin/v1/appeals/
// {appeal_id} and /admin/v1/blocked-requests. app.module imports this module on the admin entry
// only. Permission checks go through platform's AdminOperationGuard and the phone lookup's audit
// record through platform's AUDIT_PORT, both provided by the admin module on the admin entry
// (risk never imports admin). Other modules' reads come through ports app.module builds
// (identity's masked phones, normaliser and phone holders, admin's display names, orders'
// sub-order numbers). Without a database or field cipher (isolated HTTP unit tests) the routes
// still register and every read fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AUDIT_PORT,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  type AuditPort,
  type Clock,
  type FieldCrypto,
} from '../../../platform/index.ts';
import {
  AdminAppealsRead,
  type AdminAppealsReadPorts,
} from '../../application/admin-appeals-read.ts';
import { AdminAppealsController } from './appeals.controller.ts';

export interface RiskAppealsAdminOptions {
  /** Builds the reads of other modules' tables over the entry's database and field cipher. */
  readonly ports: (db: Kysely<Database>, crypto: FieldCrypto) => AdminAppealsReadPorts;
}

/** Stands in for the reads when the entry has no database, field cipher or audit port. */
function unavailable(): AdminAppealsRead {
  const fail = () => Promise.reject(new Error('risk: appeal reads need the database'));
  return { list: fail, get: fail, blockedRequests: fail } as unknown as AdminAppealsRead;
}

@Module({})
export class RiskAppealsAdminModule {
  static forAdmin(options: RiskAppealsAdminOptions): DynamicModule {
    return {
      module: RiskAppealsAdminModule,
      controllers: [AdminAppealsController],
      providers: [
        {
          provide: AdminAppealsRead,
          inject: [
            CLOCK,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: AUDIT_PORT, optional: true },
          ],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
            audit?: AuditPort,
          ): AdminAppealsRead => {
            if (db === undefined || crypto === undefined || audit === undefined) {
              return unavailable();
            }
            return new AdminAppealsRead({
              db,
              clock,
              crypto,
              audit,
              ports: options.ports(db, crypto),
            });
          },
        },
      ],
    };
  }
}
