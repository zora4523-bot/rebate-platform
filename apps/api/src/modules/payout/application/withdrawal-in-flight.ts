import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** Structural implementation of identity's two withdrawal reader ports. */
export interface WithdrawalReaders {
  hasInFlight(trx: Transaction<DB>, input: { appId: string; userId: string }): Promise<boolean>;
  hasNonTerminal(trx: Transaction<DB>, input: { appId: string; userId: string }): Promise<boolean>;
}
export function createWithdrawalInFlightReader(options: { clock: Clock }): WithdrawalReaders {
  void options;
  throw new Error('NotImplemented: createWithdrawalInFlightReader');
}
