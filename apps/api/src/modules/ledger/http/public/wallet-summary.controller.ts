import type { Schema } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../../platform/index.ts';
import type { WalletSummaryQuery } from '../../application/wallet-summary.ts';

export interface WalletSummaryRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
}

export class WalletSummaryController {
  constructor(query: WalletSummaryQuery) {
    void query;
    throw new Error('NotImplemented: WalletSummaryController');
  }

  async summary(request: WalletSummaryRequest): Promise<Schema<'WalletSummaryResponse'>> {
    void request;
    throw new Error('NotImplemented: WalletSummaryController.summary');
  }
}
