// Risk scans of the worker entry (BR-ID-36, B1-03j): app.module imports this module on `worker`
// only. It builds the risk state service (the single writer of user_risk_state) over DB and
// EVENT_BUS, the scan over it, and registers the scan's handler on JOB_QUEUE for queue
// `risk-scan` (in the worker's ENTRY_PLAN only). Seeding the chain is entry.ts's job, after the
// queue runtime started (seedRiskScan with riskScanToken()). Without a database handle nothing
// is registered, riskScanToken() provides null and one info line `risk_scan_disabled` is logged.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories).
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  EVENT_BUS,
  JOB_QUEUE,
  ROOT_LOGGER,
  type Clock,
  type EventBus,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import {
  RISK_SCAN_QUEUE,
  createRiskScan,
  riskScanToken,
  type RiskScan,
} from './application/risk-scan.ts';
import { createRiskStateService } from './application/risk-state.ts';

@Module({})
export class RiskScanModule {
  static forWorker(): DynamicModule {
    return {
      module: RiskScanModule,
      providers: [
        {
          provide: riskScanToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: EVENT_BUS, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            events?: EventBus,
            queue?: QueueRuntime,
          ): RiskScan | null => {
            if (db === undefined || events === undefined || queue === undefined) {
              logger.info({ queue: RISK_SCAN_QUEUE }, 'risk_scan_disabled');
              return null;
            }
            const riskState = createRiskStateService({ db, clock, events });
            const scan = createRiskScan({ db, clock, riskState, queue, logger });
            queue.register(RISK_SCAN_QUEUE, (job) => scan.handle(job));
            return scan;
          },
        },
      ],
      exports: [riskScanToken()],
    };
  }
}
