import type { Schema } from '@couli/contracts-ts';
import type { CheckedRequest } from '../../../platform/index.ts';

/** B1-11e: the implementation will register the contract route and inject its dependencies. */
export class InviterController {
  async bindInviter(request: CheckedRequest): Promise<Schema<'EmptyResponse'>> {
    void request;
    throw new Error('NotImplemented: InviterController.bindInviter');
  }
}
