// GET /admin/v1/union/account-options (B1-22o; adminListUnionAccountOptions, D10-243). Skeleton
// only, not mounted yet: the implementation round adds the route decorators, mounts it in
// UnionAdminModule on the admin entry and removes x-implementation planned. AdminOperationGuard
// checks union.pid or union.account_auth (either), read only without step-up.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard } from '../../../platform/index.ts';
import type { AdminUnionAccountOptions } from '../../application/admin-account-options.ts';
import type { AdminUnionAccountRequest } from './union-accounts.controller.ts';

export interface AdminUnionAccountOptionsControllerDeps {
  readonly guard: AdminOperationGuard;
  readonly options: AdminUnionAccountOptions;
}

export class AdminUnionAccountOptionsController {
  constructor(deps: AdminUnionAccountOptionsControllerDeps) {
    void deps;
    throw new Error('NotImplemented: AdminUnionAccountOptionsController');
  }

  list(request: AdminUnionAccountRequest): Promise<Schema<'AdminUnionAccountOptionListResponse'>> {
    void request;
    throw new Error('NotImplemented: AdminUnionAccountOptionsController.list');
  }
}
