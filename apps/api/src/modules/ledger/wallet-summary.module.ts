import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, type Clock } from '../platform/index.ts';
import {
  getWalletSummary,
  type WalletSummaryDependencies,
  type WalletSummaryQuery,
} from './application/wallet-summary.ts';
import {
  WALLET_SUMMARY_QUERY,
  WalletSummaryController,
} from './http/public/wallet-summary.controller.ts';

export interface WalletSummaryModuleOptions {
  /** The owner modules' ports (pending earnings, withdrawals, risk, config), on the entry's DB. */
  readonly dependencies: (db: Kysely<Database>, clock: Clock) => WalletSummaryDependencies;
}

/**
 * GET /v1/wallet/summary on the api entry (B2-04y). The route is mounted with or without a
 * database; without one every read is refused (never an empty wallet).
 */
export class WalletSummaryModule {
  static forApi(options: WalletSummaryModuleOptions): DynamicModule {
    return {
      module: WalletSummaryModule,
      controllers: [WalletSummaryController],
      providers: [
        {
          provide: WALLET_SUMMARY_QUERY,
          inject: [CLOCK, { token: DB, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>): WalletSummaryQuery => {
            if (db === undefined) {
              return () => Promise.reject(new Error('ledger: wallet summary needs the database'));
            }
            const dependencies = options.dependencies(db, clock);
            return (subject) => getWalletSummary(db, subject, dependencies);
          },
        },
      ],
    };
  }
}
