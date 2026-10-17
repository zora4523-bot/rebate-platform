import type { DynamicModule } from '@nestjs/common';

export class OrdersModule {
  static forRoot(): DynamicModule {
    throw new Error('NotImplemented: OrdersModule.forRoot');
  }
}
