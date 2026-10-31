// risk's appeal console reads (B1-03zd, CT-24r): GET /admin/v1/appeals, /admin/v1/appeals/
// {appeal_id} and /admin/v1/blocked-requests. app.module imports this module on the admin entry
// only. Permission checks go through platform's AdminOperationGuard and the phone lookup's audit
// record through platform's AUDIT_PORT, both provided by the admin module on the admin entry
// (risk never imports admin). Other modules' reads come through ports app.module builds
// (identity's masked phones, normaliser and phone holders, admin's display names, orders'
// sub-order numbers). Without a database or field cipher (isolated HTTP unit tests) the routes
// still register and every read fails closed (50001).
// B1-03ze: the console writes (register, claim, resolve) on the same module. Their audit writer is
// bound to each write's transaction (app.module: admin's createAuditWriter), the bindings blocked
// for ban come back through linking's restoreAfterUnban and the voided order's owner through an
// orders read app.module builds; the calendar through content's configuration reader. The risk
// state writer is its own createRiskStateService over the same REDIS (the version stamp reaches
// the api entry's caches), as RiskAdminModule's. Without a database, event bus, field cipher or
// audit port every write fails closed (50001) as well.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  AUDIT_PORT,
  CLOCK,
  DB,
  EVENT_BUS,
  FIELD_CRYPTO,
  REDIS,
  ROOT_LOGGER,
  type AuditPort,
  type Clock,
  type EventBus,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../../../platform/index.ts';
import {
  AdminAppealsRead,
  type AdminAppealsReadPorts,
} from '../../application/admin-appeals-read.ts';
import {
  AdminAppealsWrite,
  type AdminAppealsWriteOptions,
  type AdminAppealsWritePorts,
} from '../../application/admin-appeals-write.ts';
import type { RateLimitConfigReader } from '../../application/rate-limit.ts';
import { createRiskStateService } from '../../application/risk-state.ts';
import { AdminAppealsController } from './appeals.controller.ts';
import { AdminAppealsWriteController } from './appeals-write.controller.ts';

/** B1-03ze: what the console writes need from other modules (risk imports none of them). */
export interface RiskAppealsAdminWriteOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** linking's restore of the user's bindings blocked for ban. */
  readonly restoreAfterUnban: AdminAppealsWriteOptions['restoreAfterUnban'];
  /** The orders read of the voided order's owner, over the entry's database. */
  readonly ports: (db: Kysely<Database>) => AdminAppealsWritePorts;
  /** The working-day calendar reader (content's configuration reader) over a handle. */
  readonly config: (db: Kysely<Database>, clock: Clock) => RateLimitConfigReader;
}

export interface RiskAppealsAdminOptions {
  /** Builds the reads of other modules' tables over the entry's database and field cipher. */
  readonly ports: (db: Kysely<Database>, crypto: FieldCrypto) => AdminAppealsReadPorts;
  /** The console writes; absent: the write routes register and fail closed (50001). */
  readonly writes?: RiskAppealsAdminWriteOptions;
}

/** Stands in for the reads when the entry has no database, field cipher or audit port. */
function unavailable(): AdminAppealsRead {
  const fail = () => Promise.reject(new Error('risk: appeal reads need the database'));
  return { list: fail, get: fail, blockedRequests: fail } as unknown as AdminAppealsRead;
}

/** Stands in for the writes when the entry lacks what they need: fails closed. */
function writesUnavailable(): AdminAppealsWrite {
  const fail = () => Promise.reject(new Error('risk: appeal writes need the database'));
  return { claim: fail, prepareResolve: fail, register: fail } as unknown as AdminAppealsWrite;
}

@Module({})
export class RiskAppealsAdminModule {
  static forAdmin(options: RiskAppealsAdminOptions): DynamicModule {
    const writes = options.writes;
    return {
      module: RiskAppealsAdminModule,
      controllers: [AdminAppealsController, AdminAppealsWriteController],
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
        {
          provide: AdminAppealsWrite,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            AdminAppealsRead,
            { token: DB, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: FIELD_CRYPTO, optional: true },
            { token: AUDIT_PORT, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            reads: AdminAppealsRead,
            db?: Kysely<Database>,
            events?: EventBus,
            crypto?: FieldCrypto,
            audit?: AuditPort,
            redis?: RedisHandle,
          ): AdminAppealsWrite => {
            if (
              writes === undefined ||
              db === undefined ||
              events === undefined ||
              crypto === undefined ||
              audit === undefined
            ) {
              return writesUnavailable();
            }
            const withRedis = redis === undefined ? {} : { redis };
            return new AdminAppealsWrite({
              db,
              clock,
              events,
              logger,
              ...withRedis,
              riskState: createRiskStateService({ db, clock, events, ...withRedis }),
              config: writes.config(db, clock),
              auditOn: (trx: Transaction<Database>) => writes.auditWriter(trx, clock),
              restoreAfterUnban: writes.restoreAfterUnban,
              ports: writes.ports(db),
              reads,
            });
          },
        },
      ],
    };
  }
}
