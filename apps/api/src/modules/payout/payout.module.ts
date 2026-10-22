import type { DynamicModule } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { WithdrawRulesService } from './application/withdraw-rules.ts';

export interface PayoutModuleOptions {
  rules?: WithdrawRulesService;
  handle?: Kysely<DB>;
}

export class PayoutModule {
  static forRoot(options?: PayoutModuleOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: PayoutModule.forRoot');
  }
}
