import type { DynamicModule } from '@nestjs/common';
import { CLOCK, type Clock } from '../platform/index.ts';
import { createLedger, type Ledger } from './application/ledger.ts';

/** Nest injection token for the process ledger (the Clock-backed posting port). */
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
          inject: [CLOCK],
          useFactory: (clock: Clock): Ledger => createLedger({ clock }),
        },
      ],
      exports: [LEDGER],
    };
  }
}
