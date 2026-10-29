import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, EVENT_BUS, type Clock, type EventBus } from '../platform/index.ts';
import { BalanceRecoveredHook, createLedger } from './application/recovered-ledger.ts';
import type { Ledger } from './application/reverse.ts';
import {
  AdminReconDiffsController,
  RECON_DIFF_READ_DB,
} from './http/admin/recon-diffs.controller.ts';

/** Nest injection token for the process ledger (the Clock-backed posting port, with the optional event bus and recovery port). */
export const LEDGER = Symbol('LEDGER');

/**
 * The ledger port over the process Clock. It holds no database handle: every call runs on the
 * caller's handle or transaction, so the module needs nothing at startup.
 */
export class LedgerModule {
  static forRoot(): DynamicModule {
    return {
      module: LedgerModule,
      providers: [
        {
          provide: LEDGER,
          // EVENT_BUS exists only where the entry has a database (PlatformModule); entries
          // without one cannot post, so the bus is optional here like DB elsewhere.
          // BALANCE_RECOVERED_HOOK is provided by payout where it runs (BR-WDR-05 (a));
          // elsewhere it is absent and recovery calls nothing.
          inject: [
            CLOCK,
            { token: EVENT_BUS, optional: true },
            { token: BalanceRecoveredHook, optional: true },
          ],
          useFactory: (
            clock: Clock,
            eventBus: EventBus | undefined,
            balanceRecoveredHook: BalanceRecoveredHook | undefined,
          ): Ledger =>
            createLedger({
              clock,
              ...(eventBus === undefined ? {} : { eventBus }),
              ...(balanceRecoveredHook === undefined ? {} : { balanceRecoveredHook }),
            }),
        },
      ],
      exports: [LEDGER],
    };
  }
}

/**
 * B2-09a: the admin entry's R1–R3 recon diff reads (GET /admin/v1/recon-diffs and its detail),
 * guarded through platform's AdminOperationGuard and read on the primary handle. Without the
 * database the routes still register and fail closed (50001).
 */
export class LedgerAdminModule {
  static forAdmin(): DynamicModule {
    return {
      module: LedgerAdminModule,
      controllers: [AdminReconDiffsController],
      providers: [
        {
          provide: RECON_DIFF_READ_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): Kysely<Database> | null => db ?? null,
        },
      ],
    };
  }
}
