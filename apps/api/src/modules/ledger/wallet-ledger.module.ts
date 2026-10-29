import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { DB } from '../platform/index.ts';
import {
  getWalletLedger,
  type WalletLedgerDependencies,
  type WalletLedgerQuery,
} from './application/wallet-ledger.ts';
import {
  WALLET_LEDGER_QUERY,
  WalletLedgerController,
} from './http/public/wallet-ledger.controller.ts';

export interface WalletLedgerModuleOptions {
  /** The owner modules' read ports (paid withdrawals from payout, order ids from settlement). */
  readonly dependencies: WalletLedgerDependencies;
}

/**
 * GET /v1/wallet/ledger on the api entry (B2-04zc, BR-FUND-15 / BR-TEXT-19). The route is mounted
 * with or without a database; without one every read is refused (never an empty ledger).
 */
export class WalletLedgerModule {
  static forApi(options: WalletLedgerModuleOptions): DynamicModule {
    return {
      module: WalletLedgerModule,
      controllers: [WalletLedgerController],
      providers: [
        {
          provide: WALLET_LEDGER_QUERY,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>): WalletLedgerQuery => {
            if (db === undefined) {
              return () => Promise.reject(new Error('ledger: wallet ledger needs the database'));
            }
            return (request) => getWalletLedger(db, request, options.dependencies);
          },
        },
      ],
    };
  }
}
