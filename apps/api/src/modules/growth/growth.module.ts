import type { DynamicModule } from '@nestjs/common';

/** B1-11e: HTTP module assembly is implemented after the rule tests are confirmed red. */
export class GrowthModule {
  static forRoot(): DynamicModule {
    throw new Error('NotImplemented: GrowthModule.forRoot');
  }
}
