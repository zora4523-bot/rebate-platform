import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB as DB_TOKEN, type Clock } from '../platform/index.ts';
import type { AdminSettleBillReadDeps } from './application/admin-settle-bills.ts';
import {
  ADMIN_SETTLE_BILL_READS,
  AdminSettleBillsController,
} from './http/admin/settle-bills.controller.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from './rebate/application/rebate.ts';

/** Nest injection token for the pre-credit rebate port (orders' rebate.onImported / onUpdated). */
export const REBATE_PORT = Symbol('REBATE_PORT');

/** Standalone module only; orders worker wiring belongs to B2-04zb. */
export class SettlementModule {
  static register(deps: RebateDependencies): DynamicModule {
    return {
      module: SettlementModule,
      providers: [
        {
          provide: REBATE_PORT,
          useFactory: (): RebatePort => createRebatePort(deps),
        },
      ],
      exports: [REBATE_PORT],
    };
  }
}

/**
 * B2-09d: the settlement console's monthly bill reads on the admin entry (settle.bill or
 * fund.view, read only, no audit). Without a database the routes register and fail closed.
 */
export class SettlementAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: SettlementAdminModule,
      controllers: [AdminSettleBillsController],
      providers: [
        {
          provide: ADMIN_SETTLE_BILL_READS,
          inject: [CLOCK, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<DB>): AdminSettleBillReadDeps | null =>
            db === undefined ? null : { db, now: () => clock.now() },
        },
      ],
    };
  }
}
