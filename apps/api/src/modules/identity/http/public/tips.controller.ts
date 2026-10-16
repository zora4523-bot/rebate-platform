import type { Schema } from '@couli/contracts-ts';
import type { CheckedRequest } from '../../../platform/index.ts';

// B1-02s test phase: routing, @Req() on the first argument, DB/CLOCK injection and
// IdentityModule registration belong to implementation after enabling the contract.
export class TipsController {
  getTips(request: CheckedRequest): Promise<Schema<'TipsResponse'>> {
    void request;
    throw new Error('NotImplemented: TipsController.getTips');
  }

  markTipRead(request: CheckedRequest): Promise<Schema<'EmptyResponse'>> {
    void request;
    throw new Error('NotImplemented: TipsController.markTipRead');
  }

  resetTip(request: CheckedRequest): Promise<Schema<'EmptyResponse'>> {
    void request;
    throw new Error('NotImplemented: TipsController.resetTip');
  }
}
