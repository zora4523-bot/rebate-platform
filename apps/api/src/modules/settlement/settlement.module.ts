import type { DynamicModule } from '@nestjs/common';
import type { RebateDependencies } from './rebate/application/rebate.ts';

/** Standalone module only; orders worker wiring belongs to B2-04zb. */
export class SettlementModule {
  static register(deps: RebateDependencies): DynamicModule {
    void deps;
    throw new Error('NotImplemented: SettlementModule.register');
  }
}
