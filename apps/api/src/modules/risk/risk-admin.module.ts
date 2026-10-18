// risk's admin console routes (F1-07d): PUT /admin/v1/users/{user_id}/risk-state (ban / unban /
// freeze / unfreeze; BR-ID-31). app.module imports this module on the admin entry only; the api
// and stream entries do not serve /admin/v1. Permission and step-up checks go through platform's
// AdminOperationGuard, which the admin module provides on the admin entry (risk never imports
// admin). The effects of a ban and an unban come through ports app.module builds (identity's
// revocation by user, linking's blockForBan / restoreAfterUnban; risk imports neither, identity
// already imports risk), and so does the audit writer bound to the change's transaction. The
// service's risk state writer is its own createRiskStateService over the same REDIS, so the
// version stamp reaches the api entry's caches. Without a database or event bus (isolated HTTP
// unit tests) the route still registers and every change fails closed (50001); without REDIS
// every change fails closed as well (admin-risk-state.ts).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  REDIS,
  ROOT_LOGGER,
  type AuditPort,
  type Clock,
  type EventBus,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import { AdminRiskState, type AdminRiskStateOptions } from './application/admin-risk-state.ts';
import { createRiskStateService } from './application/risk-state.ts';
import { AdminRiskStateController } from './http/admin/risk-state.controller.ts';

export interface RiskAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** identity's revocation of every session of the user, on the caller's transaction. */
  readonly revokeSessions: (clock: Clock) => AdminRiskStateOptions['revokeSessions'];
  /** linking's ban / unban ports of the user's union bindings. */
  readonly blockForBan: AdminRiskStateOptions['blockForBan'];
  readonly restoreAfterUnban: AdminRiskStateOptions['restoreAfterUnban'];
}

/** Stands in for the service when the entry has no database or event bus: fails closed. */
const UNAVAILABLE = {
  apply: () => Promise.reject(new Error('risk: risk state changes need the database')),
} as unknown as AdminRiskState;

@Module({})
export class RiskAdminModule {
  static forAdmin(options: RiskAdminOptions): DynamicModule {
    return {
      module: RiskAdminModule,
      controllers: [AdminRiskStateController],
      providers: [
        {
          provide: AdminRiskState,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            events?: EventBus,
            redis?: RedisHandle,
          ): AdminRiskState => {
            if (db === undefined || events === undefined) return UNAVAILABLE;
            const withRedis = redis === undefined ? {} : { redis };
            return new AdminRiskState({
              db,
              clock,
              events,
              logger,
              ...withRedis,
              riskState: createRiskStateService({ db, clock, events, ...withRedis }),
              auditOn: (trx: Transaction<Database>) => options.auditWriter(trx, clock),
              revokeSessions: options.revokeSessions(clock),
              blockForBan: options.blockForBan,
              restoreAfterUnban: options.restoreAfterUnban,
            });
          },
        },
      ],
    };
  }
}
