import type { DynamicModule } from '@nestjs/common';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../platform/index.ts';
import { createLedger } from './application/event-ledger.ts';
import type { Ledger } from './application/reverse.ts';

/** Nest injection token for the process ledger (the Clock-backed posting port, with the event bus). */
export const LEDGER = Symbol('LEDGER');

/**
 * The ledger port over the process Clock. It holds no database handle: every call runs on the
 * caller's handle or transaction, so the module needs nothing at startup.
 */
export class LedgerModule {
  static forRoot(): DynamicModule {
    return {
      module: LedgerModule,
      providers: [
        {
          provide: LEDGER,
          // EVENT_BUS exists only where the entry has a database (PlatformModule); entries
          // without one cannot post, so the bus is optional here like DB elsewhere.
          inject: [CLOCK, { token: EVENT_BUS, optional: true }],
          useFactory: (clock: Clock, eventBus: EventBus | undefined): Ledger =>
            createLedger(eventBus === undefined ? { clock } : { clock, eventBus }),
        },
      ],
      exports: [LEDGER],
    };
  }
}
