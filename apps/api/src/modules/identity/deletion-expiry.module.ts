// identity on the worker entry (task B1-15f §9.2 #1): the scheduled processing of deletion requests
// whose cooling period has ended. app.module imports this module on `worker` only, beside
// IdentityWorkerModule (whose forWorker options stay as they are); entry.ts starts the timer after
// the payout verification recheck (startDeletionExpiry with deletionExpiryToken()). Without a
// database deletionExpiryToken() provides null and one info line is logged.
// The module and the option factories app.module passes depend only on the platform tokens CLOCK,
// ROOT_LOGGER, APP_CONFIG and (optional) DB, like IdentityWorkerModule.
// The withdrawal port is app.module's truthful "no withdrawal" implementation until B2-05
// (hasNonTerminal answers false; TODO(规划/11 §2.3) there — blocked on B2-05); the balance port is
// the one app.module assembles for B1-15d over the ledger's getBalances, on the caller's transaction.
//
// Also compiled by the `test` project: a class decorator only (dependencies through factories).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { CLOCK, DB, ROOT_LOGGER, type Clock, type RootLogger } from '../platform/index.ts';
import {
  createDeletionExpiry,
  deletionExpiryToken,
  type DeletionCalendarConfigReader,
  type DeletionExpiry,
} from './application/deletion-expiry.ts';
import type { DeletionBalanceReader } from './ports/deletion-balance.ts';
import type { WithdrawalNonTerminalReader } from './ports/withdrawal-in-flight.ts';

export interface IdentityDeletionExpiryModuleOptions {
  readonly calendarConfig: Omit<FactoryProvider<DeletionCalendarConfigReader>, 'provide'>;
  readonly withdrawals: Omit<FactoryProvider<WithdrawalNonTerminalReader>, 'provide'>;
  readonly balance: Omit<FactoryProvider<DeletionBalanceReader>, 'provide'>;
}

const CALENDAR_CONFIG = Symbol('IDENTITY_DELETION_EXPIRY_CALENDAR_CONFIG');
const WITHDRAWALS = Symbol('IDENTITY_DELETION_EXPIRY_WITHDRAWALS');
const BALANCE = Symbol('IDENTITY_DELETION_EXPIRY_BALANCE');

@Module({})
export class IdentityDeletionExpiryModule {
  static forWorker(options: IdentityDeletionExpiryModuleOptions): DynamicModule {
    return {
      module: IdentityDeletionExpiryModule,
      providers: [
        { ...options.calendarConfig, provide: CALENDAR_CONFIG },
        { ...options.withdrawals, provide: WITHDRAWALS },
        { ...options.balance, provide: BALANCE },
        {
          provide: deletionExpiryToken(),
          inject: [
            CLOCK,
            ROOT_LOGGER,
            CALENDAR_CONFIG,
            WITHDRAWALS,
            BALANCE,
            { token: DB, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            calendar: DeletionCalendarConfigReader,
            withdrawals: WithdrawalNonTerminalReader,
            balance: DeletionBalanceReader,
            db?: Kysely<Database>,
          ): DeletionExpiry | null => {
            if (db === undefined) {
              logger.info({}, 'identity_deletion_expiry_disabled');
              return null;
            }
            return createDeletionExpiry({ db, clock, logger, withdrawals, balance, calendar });
          },
        },
      ],
      exports: [deletionExpiryToken()],
    };
  }
}
