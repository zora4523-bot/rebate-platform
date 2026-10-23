import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { Ledger } from './reverse.ts';

export interface BalanceRecoveredInput {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly availableBefore: bigint;
  readonly availableAfter: bigint;
  readonly voucherId: string;
}

/** BR-WDR-05 (a): synchronous transactional port; the class also serves as a DI token. */
export class BalanceRecoveredHook {
  onRecovered(trx: Transaction<DB>, input: BalanceRecoveredInput): Promise<void> {
    void trx;
    void input;
    throw new Error('NotImplemented: BalanceRecoveredHook.onRecovered');
  }
}

/** Omitted hook means no cleanup; supplied hook failures must roll back the posting savepoint. */
export interface RecoveredLedgerOptions {
  readonly clock: Clock;
  readonly eventBus?: EventBus;
  readonly balanceRecoveredHook?: BalanceRecoveredHook;
}

export function createLedger(input: RecoveredLedgerOptions): Ledger {
  void input;
  throw new Error('NotImplemented: createLedger');
}
