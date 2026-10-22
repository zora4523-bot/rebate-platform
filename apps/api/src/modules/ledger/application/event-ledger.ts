import type { Clock, EventBus } from '../../platform/index.ts';
import { createLedger as createPostingLedger, type Ledger } from './reverse.ts';

/**
 * The public ledger factory (B2-04k): the posting / reverse service of reverse.ts with the
 * platform event bus. post publishes account.went_negative on the posting transaction, inside its
 * savepoint, for every user account whose available goes from >= 0 to < 0 (S21, BR-WDR-05 (a)).
 * The bus is optional like the EVENT_BUS provider; without it no event is published (the withdraw
 * guards stay the hard constraint, the event only speeds up the handling).
 */
export function createLedger(input: {
  readonly clock: Clock;
  readonly eventBus?: EventBus;
}): Ledger {
  return createPostingLedger(
    input.eventBus === undefined
      ? { clock: input.clock }
      : { clock: input.clock, eventBus: input.eventBus },
  );
}
