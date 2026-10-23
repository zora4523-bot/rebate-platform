// B2-05k: payout's implementation of ledger's recovery port (BR-WDR-05 (a), BR-FUND-12). ledger
// calls onRecovered on the posting transaction, inside the voucher's savepoint, when a member's
// available goes from < 0 to >= 0; payout clears blocked_reason = NEGATIVE_BALANCE on that member's
// withdrawals there (one UPDATE on the same trx: blocked_reason NULL, updated_at from the injected
// Clock, row_version + 1; no status change, no voucher, no event). A failure undoes the voucher.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import {
  BALANCE_RECOVERED_HOOK as RecoveredHookBase,
  type BalanceRecoveredHook,
  type BalanceRecoveredInput,
} from '../../ledger/index.ts';
import type { Clock } from '../../platform/index.ts';

export interface BalanceRecoveredHookOptions {
  readonly clock: Clock;
}

const BLOCKED_NEGATIVE = 'NEGATIVE_BALANCE';

/** payout's recovery port: the member's NEGATIVE_BALANCE blocks go in the recovering posting. */
class NegativeBalanceRecoveredHook extends RecoveredHookBase {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    super();
    this.#clock = clock;
  }

  override async onRecovered(trx: Transaction<DB>, input: BalanceRecoveredInput): Promise<void> {
    // ledger only calls this when available went from < 0 to >= 0; a still-negative call (a
    // caller outside ledger) must not clear anything.
    if (input.availableAfter < 0n) return;
    await trx
      .withSchema('app')
      .updateTable('withdrawals')
      .set({
        blocked_reason: null,
        updated_at: this.#clock.now(),
        row_version: sql`row_version + 1`,
      })
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .where('blocked_reason', '=', BLOCKED_NEGATIVE)
      .execute();
  }
}

/** The port instance app.module hands to every createLedger that books money. */
export function createBalanceRecoveredHook(
  options: BalanceRecoveredHookOptions,
): BalanceRecoveredHook {
  return new NegativeBalanceRecoveredHook(options.clock);
}
