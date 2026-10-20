import type { DynamicModule, FactoryProvider } from '@nestjs/common';
import type { PayoutAccountConfigPort } from './application/payout-account.ts';

export interface IdentityWorkerModuleOptions {
  readonly payoutAccountConfig: Omit<FactoryProvider<PayoutAccountConfigPort>, 'provide'>;
}

export class IdentityWorkerModule {
  static forWorker(options: IdentityWorkerModuleOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: IdentityWorkerModule.forWorker');
  }
}
