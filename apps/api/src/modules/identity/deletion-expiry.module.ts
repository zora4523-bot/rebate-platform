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
// NotImplemented skeleton written by the rule-test author: the implementer adds the @Module({})
// decorator and the providers (option names may be reshaped; the rule tests do not read them).
import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import type { DeletionCalendarConfigReader } from './application/deletion-expiry.ts';
import type { DeletionBalanceReader } from './ports/deletion-balance.ts';
import type { WithdrawalNonTerminalReader } from './ports/withdrawal-in-flight.ts';

export interface IdentityDeletionExpiryModuleOptions {
  readonly calendarConfig: Omit<FactoryProvider<DeletionCalendarConfigReader>, 'provide'>;
  readonly withdrawals: Omit<FactoryProvider<WithdrawalNonTerminalReader>, 'provide'>;
  readonly balance: Omit<FactoryProvider<DeletionBalanceReader>, 'provide'>;
}

export class IdentityDeletionExpiryModule {
  static forWorker(options: IdentityDeletionExpiryModuleOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: IdentityDeletionExpiryModule.forWorker');
  }
}
