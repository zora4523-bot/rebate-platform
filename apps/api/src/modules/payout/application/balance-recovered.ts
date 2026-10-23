// B2-05k: payout's implementation of ledger's recovery port (BR-WDR-05 (a), BR-FUND-12). ledger
// calls onRecovered on the posting transaction, inside the voucher's savepoint, when a member's
// available goes from < 0 to >= 0; payout clears blocked_reason = NEGATIVE_BALANCE on that member's
// withdrawals there (one UPDATE on the same trx: blocked_reason NULL, updated_at from the injected
// Clock, row_version + 1; no status change, no voucher, no event). A failure undoes the voucher.
import type { BalanceRecoveredHook } from '../../ledger/index.ts';
import type { Clock } from '../../platform/index.ts';

export interface BalanceRecoveredHookOptions {
  readonly clock: Clock;
}

/** The port instance app.module hands to every createLedger that books money. */
export function createBalanceRecoveredHook(
  options: BalanceRecoveredHookOptions,
): BalanceRecoveredHook {
  void options;
  throw new Error('NotImplemented: createBalanceRecoveredHook');
}
