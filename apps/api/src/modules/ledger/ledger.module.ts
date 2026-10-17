import type { DynamicModule } from '@nestjs/common';

/** Implementation phase wires the Clock-backed port and registers this module in AppModule. */
export class LedgerModule {
  static forRoot(): DynamicModule {
    throw new Error('NotImplemented: LedgerModule.forRoot');
  }
}
