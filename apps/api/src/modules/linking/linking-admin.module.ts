// linking's admin console routes (F1-07c): POST /admin/v1/users/{user_id}/union-bindings/
// {platform}/reset | disable | enable (BR-ID-20). app.module imports this module on the admin
// entry only; the api and stream entries do not serve /admin/v1. Permission and step-up checks go
// through platform's AdminOperationGuard, which the admin module provides on the admin entry
// (linking never imports admin). The change and its audit row share one transaction: app.module
// passes `auditWriter` (admin's writer bound to a handle) and `configReader` (content's reader, for
// bind.rebind_cooldown_days). A reset clears the user's converted links in the open's Redis
// namespace (linking-jump). Without a database (isolated HTTP unit tests) the routes still register
// and every change fails closed (50001).
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  REDIS,
  ROOT_LOGGER,
  type AuditPort,
  type Clock,
  type RedisHandle,
  type RootLogger,
} from '../platform/index.ts';
import {
  AdminUnionBindings,
  type AdminUnionBindingsStore,
} from './application/admin-union-bindings.ts';
import { AdminUnionBindingsController } from './http/admin/union-bindings.controller.ts';
import { createKyselyAdminUnionBindingsStore } from './infra/admin-union-bindings-store.ts';
import { LINK_JUMP_REDIS_NAMESPACE, createRedisJumpCachePurger } from './infra/jump-cache.ts';
import type { LinkingConfigReaderFactory } from './linking.module.ts';

/** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
export type LinkingAuditWriterFactory = (db: Kysely<Database>, clock: Clock) => AuditPort;

export interface LinkingAdminOptions {
  readonly auditWriter: LinkingAuditWriterFactory;
  readonly configReader: LinkingConfigReaderFactory;
}

const NO_DATABASE: AdminUnionBindingsStore = {
  transaction: () => Promise.reject(new Error('linking: union binding changes need the database')),
};

@Module({})
export class LinkingAdminModule {
  static forAdmin(options: LinkingAdminOptions): DynamicModule {
    return {
      module: LinkingAdminModule,
      controllers: [AdminUnionBindingsController],
      providers: [
        {
          provide: AdminUnionBindings,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: REDIS, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            redis?: RedisHandle,
          ): AdminUnionBindings => {
            const purger =
              redis === undefined
                ? undefined
                : createRedisJumpCachePurger(redis.namespace(LINK_JUMP_REDIS_NAMESPACE));
            return new AdminUnionBindings({
              store:
                db === undefined
                  ? NO_DATABASE
                  : createKyselyAdminUnionBindingsStore(
                      db,
                      (trx) => options.auditWriter(trx, clock),
                      (trx) => options.configReader(trx, clock),
                    ),
              clock,
              logger,
              ...(purger === undefined
                ? {}
                : {
                    purgeUserLinks: (appId: string, userId: string) =>
                      purger.purgeUser(appId, userId),
                  }),
            });
          },
        },
      ],
    };
  }
}
