import type { Clock, EventBus } from '../../platform/index.ts';
import type { Ledger } from './reverse.ts';

/**
 * B2-04k public factory skeleton. Implementation must compose the existing posting/reverse
 * service and publish through the injected bus inside post's transaction/savepoint.
 * Optional in the type for existing callers; production wiring must supply the platform bus.
 */
export function createLedger(input: {
  readonly clock: Clock;
  readonly eventBus?: EventBus;
}): Ledger {
  void input;
  throw new Error('NotImplemented: createLedger.account.went_negative');
}
