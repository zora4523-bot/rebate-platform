import type { DynamicModule } from '@nestjs/common';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from './rebate/application/rebate.ts';

/** Nest injection token for the pre-credit rebate port (orders' rebate.onImported / onUpdated). */
export const REBATE_PORT = Symbol('REBATE_PORT');

/** Standalone module only; orders worker wiring belongs to B2-04zb. */
export class SettlementModule {
  static register(deps: RebateDependencies): DynamicModule {
    return {
      module: SettlementModule,
      providers: [
        {
          provide: REBATE_PORT,
          useFactory: (): RebatePort => createRebatePort(deps),
        },
      ],
      exports: [REBATE_PORT],
    };
  }
}
