// GET / POST / DELETE /admin/v1/union-accounts/alert-phones (B1-22g; adminListUnionAlertPhones /
// adminAddUnionAlertPhone / adminRemoveUnionAlertPhone; BR-ID-24 细则「后台告警手机号与重新授权会话」,
// D10-152 ④). To be mounted by UnionAdminModule on the admin entry only, as
// union-accounts.controller.ts: AdminOperationGuard checks union.account_auth (list read-only,
// add / remove with the totp step-up on every call). No Idempotency-Key (contract).
//
// Skeleton of the test round: every member throws NotImplemented; no route is registered yet.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard } from '../../../platform/index.ts';
import type { AdminUnionAlertPhonesService } from '../../application/admin-alert-phones.ts';
import type { AdminUnionAccountRequest } from './union-accounts.controller.ts';

/** DELETE query as the route schema delivers it. */
export interface AdminUnionAlertPhoneRemoveQuery {
  readonly phone_id: string;
  readonly expected_version: number;
}

export class AdminUnionAlertPhonesController {
  constructor(guard: AdminOperationGuard, phones: AdminUnionAlertPhonesService) {
    void guard;
    void phones;
    throw new Error('NotImplemented: AdminUnionAlertPhonesController');
  }

  list(request: AdminUnionAccountRequest): Promise<Schema<'AdminUnionAlertPhonesResponse'>> {
    void request;
    throw new Error('NotImplemented: AdminUnionAlertPhonesController.list');
  }

  add(
    request: AdminUnionAccountRequest,
    body: Schema<'AdminUnionAlertPhoneAddRequest'>,
  ): Promise<Schema<'AdminUnionAlertPhonesResponse'>> {
    void request;
    void body;
    throw new Error('NotImplemented: AdminUnionAlertPhonesController.add');
  }

  remove(
    request: AdminUnionAccountRequest,
    query: AdminUnionAlertPhoneRemoveQuery,
  ): Promise<Schema<'AdminUnionAlertPhonesResponse'>> {
    void request;
    void query;
    throw new Error('NotImplemented: AdminUnionAlertPhonesController.remove');
  }
}
