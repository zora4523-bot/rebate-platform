import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  IDEMPOTENCY,
  type AuditPort,
  type Clock,
  type EventBus,
  type Idempotency,
} from '../platform/index.ts';
import type {
  CloseAdminReconDiffDeps,
  ReconDiffHoldRelease,
} from './application/admin-recon-diff-close.ts';
import { BalanceRecoveredHook, createLedger } from './application/recovered-ledger.ts';
import type { Ledger } from './application/reverse.ts';
import {
  ASSET_SNAPSHOT_READ_DB,
  AdminAssetSnapshotsController,
} from './http/admin/asset-snapshots.controller.ts';
import {
  AdminReconDiffCloseController,
  RECON_DIFF_CLOSE_DEPS,
} from './http/admin/recon-diff-close.controller.ts';
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

/** B2-09b: what app.module hands in for the close (ledger imports neither admin nor payout). */
export interface LedgerAdminOptions {
  /** Binds the audit port to a transaction handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<Database>, clock: Clock) => AuditPort;
  /** payout's release of the holds whose source is the diff (its single writer of withdraw_holds). */
  readonly holdRelease: (clock: Clock) => ReconDiffHoldRelease;
}

/**
 * B2-09a: the admin entry's R1–R3 recon diff reads (GET /admin/v1/recon-diffs and its detail),
 * guarded through platform's AdminOperationGuard and read on the primary handle. B2-09b: the close
 * (POST /admin/v1/recon-diffs/{recon_diff_id}/close, fund.recon) under platform idempotency, with
 * payout's hold release and admin's audit writer on the closing transaction. B2-09e: the daily
 * asset snapshot list (GET /admin/v1/asset-snapshots, fund.view, read only). Without the database
 * the routes still register and fail closed (50001).
 */
export class LedgerAdminModule {
  static forAdmin(options: LedgerAdminOptions): DynamicModule {
    return {
      module: LedgerAdminModule,
      controllers: [
        AdminReconDiffsController,
        AdminReconDiffCloseController,
        AdminAssetSnapshotsController,
      ],
      providers: [
        {
          provide: RECON_DIFF_READ_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): Kysely<Database> | null => db ?? null,
        },
        {
          provide: ASSET_SNAPSHOT_READ_DB,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): Kysely<Database> | null => db ?? null,
        },
        {
          provide: RECON_DIFF_CLOSE_DEPS,
          inject: [CLOCK, { token: DB, optional: true }, { token: IDEMPOTENCY, optional: true }],
          useFactory: (
            clock: Clock,
            db?: Kysely<Database>,
            idempotency?: Idempotency,
          ): CloseAdminReconDiffDeps | null =>
            db === undefined || idempotency === undefined
              ? null
              : {
                  db,
                  clock,
                  idempotency,
                  auditOn: (trx) => options.auditWriter(trx, clock),
                  holds: options.holdRelease(clock),
                },
        },
      ],
    };
  }
}
