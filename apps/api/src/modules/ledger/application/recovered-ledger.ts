import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock, EventBus } from '../../platform/index.ts';
import type { BalanceRecoveredInput, BalanceRecoveredPort } from './ledger.ts';
import { createLedger as createPostingLedger, type Ledger } from './reverse.ts';

export type { BalanceRecoveredInput } from './ledger.ts';

/**
 * BR-WDR-05 (a): the synchronous transactional recovery port. ledger declares it; payout
 * implements it and supplies it at assembly (dependency direction payout -> ledger). The class
 * also serves as the Nest injection token; its own onRecovered is the default no-op.
 */
export class BalanceRecoveredHook implements BalanceRecoveredPort {
  onRecovered(trx: Transaction<DB>, input: BalanceRecoveredInput): Promise<void> {
    void trx;
    void input;
    return Promise.resolve();
  }
}

/** Omitted hook means no cleanup; supplied hook failures roll back the posting savepoint. */
export interface RecoveredLedgerOptions {
  readonly clock: Clock;
  readonly eventBus?: EventBus;
  readonly balanceRecoveredHook?: BalanceRecoveredHook;
}

/**
 * The public ledger factory: the posting / reverse service of reverse.ts with the optional
 * platform event bus (B2-04k: account.went_negative when available goes from >= 0 to < 0) and
 * the optional recovery port (B2-04ka: called when available goes from < 0 to >= 0). Both run
 * on the posting transaction inside post's savepoint, for post and reverse alike.
 */
export function createLedger(input: RecoveredLedgerOptions): Ledger {
  return createPostingLedger({
    clock: input.clock,
    ...(input.eventBus === undefined ? {} : { eventBus: input.eventBus }),
    ...(input.balanceRecoveredHook === undefined
      ? {}
      : { balanceRecoveredHook: input.balanceRecoveredHook }),
  });
}
