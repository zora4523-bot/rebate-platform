import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB as DB_TOKEN,
  IDEMPOTENCY,
  ROOT_LOGGER,
  type Clock,
  type Idempotency,
  type RootLogger,
} from '../platform/index.ts';
import type { AdminSettleBillReadDeps } from './application/admin-settle-bills.ts';
import {
  createAdminSettleCommandDeps,
  type AdminSettleCommandDeps,
  type AdminSettleCommandPorts,
} from './application/admin-settle-commands.ts';
import {
  ADMIN_SETTLE_BILL_READS,
  AdminSettleBillsController,
} from './http/admin/settle-bills.controller.ts';
import {
  ADMIN_SETTLE_COMMANDS,
  AdminSettleCommandsController,
} from './http/admin/settle-commands.controller.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from './rebate/application/rebate.ts';
import type { SettlementWorkerPorts } from './worker/ports.ts';

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

  /**
   * B2-04ze (D10-443): the worker entry's settle queue. With DB, JOB_QUEUE, FIELD_CRYPTO and
   * EVENT_BUS resolved (CLOCK, ROOT_LOGGER always), registers exactly one handler on queue settle
   * (worker/schedule.ts createSettleJobHandler) over createBillJob (production readSource and
   * saveBillValidations), createBatchExecutor, createCreditOrder and createBeneficiaryCredit (both
   * with readAttribution = ports.readAttribution) and createBeneficiaryGate (ports' identity,
   * risk and minors readers), plus the timer of the daily bill seed and the due batch scan (after
   * bootstrap, unref, stopped on destroy). Without a database or queue nothing is registered.
   */
  static forWorker(ports: SettlementWorkerPorts): DynamicModule {
    void ports;
    throw new Error('NotImplemented: SettlementModule.forWorker');
  }
}

/**
 * B2-09d: the settlement console's monthly bill reads on the admin entry (settle.bill or
 * fund.view, read only, no audit). B2-09f: the five writes (settle.bill, step-up totp): the batch
 * commands and the supplement launch, each with its audit record on the same transaction. Without
 * a database (or, for the writes, idempotency) the routes register and fail closed.
 */
export class SettlementAdminModule {
  static forAdmin(ports: AdminSettleCommandPorts): DynamicModule {
    return {
      module: SettlementAdminModule,
      controllers: [AdminSettleBillsController, AdminSettleCommandsController],
      providers: [
        {
          provide: ADMIN_SETTLE_BILL_READS,
          inject: [CLOCK, { token: DB_TOKEN, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<DB>): AdminSettleBillReadDeps | null =>
            db === undefined ? null : { db, now: () => clock.now() },
        },
        {
          provide: ADMIN_SETTLE_COMMANDS,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB_TOKEN, optional: true },
            { token: IDEMPOTENCY, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<DB>,
            idempotency?: Idempotency,
          ): AdminSettleCommandDeps | null =>
            db === undefined || idempotency === undefined
              ? null
              : createAdminSettleCommandDeps(ports, {
                  db,
                  clock,
                  idempotency,
                  logger: logger.child({ module: 'settlement' }),
                }),
        },
      ],
    };
  }
}
