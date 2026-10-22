import type { DynamicModule } from '@nestjs/common';

/** B1-22h: admin-entry assembly, implemented after the isolated red run. */
export class UnionAdminModule {
  static forRoot(): DynamicModule {
    throw new Error('NotImplemented: UnionAdminModule.forRoot');
  }
}
