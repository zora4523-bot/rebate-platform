import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';

export interface BindingRiskInput {
  readonly appId: string;
  readonly userId: string;
  readonly clock: Clock;
}

/** F1-07d supplies its transaction; linking remains the binding's only writer. */
export async function blockForBan(trx: Transaction<DB>, input: BindingRiskInput): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: blockForBan');
}

export async function restoreAfterUnban(
  trx: Transaction<DB>,
  input: BindingRiskInput,
): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: restoreAfterUnban');
}
