import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, type Clock } from '../platform/index.ts';
import {
  getEarningsSummary,
  type EarningsSummaryDependencies,
  type EarningsSummaryQuery,
} from './application/earnings-summary.ts';
import {
  EARNINGS_SUMMARY_QUERY,
  EarningsSummaryController,
} from './http/public/earnings-summary.controller.ts';

export interface EarningsSummaryModuleOptions {
  /** The owner modules' ports (order facts from settlement, dashboard switches), on the entry's DB. */
  readonly dependencies: (db: Kysely<Database>, clock: Clock) => EarningsSummaryDependencies;
}

/**
 * GET /v1/earnings/summary on the api entry (B2-13a, BR-FUND-25). The route is mounted with or
 * without a database; without one every read is refused (never an all-zero dashboard).
 */
export class EarningsSummaryModule {
  static forApi(options: EarningsSummaryModuleOptions): DynamicModule {
    return {
      module: EarningsSummaryModule,
      controllers: [EarningsSummaryController],
      providers: [
        {
          provide: EARNINGS_SUMMARY_QUERY,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): EarningsSummaryQuery => {
            if (db === undefined) {
              return () => Promise.reject(new Error('ledger: earnings summary needs the database'));
            }
            const dependencies = options.dependencies(db, clock);
            return (request) => getEarningsSummary(db, request, dependencies);
          },
        },
      ],
    };
  }
}
