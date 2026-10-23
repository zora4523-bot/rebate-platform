// GET /admin/v1/union-accounts, POST /admin/v1/union-accounts/{union_account_id}/reauthorize,
// GET /admin/v1/union-accounts/{union_account_id}/reauthorize/{session_id}, POST
// /admin/v1/union-accounts/oauth/callback, PUT /admin/v1/union-accounts/{union_account_id}/credential
// (B1-22d; adminListUnionAccounts / adminStartUnionReauthorization / adminGetUnionReauthorization /
// adminCompleteUnionReauthorization / adminPutUnionCredential; BR-ID-24 ③, D10-176, D10-196).
//
// SKELETON (B1-22d test round): bodies throw NotImplemented and no route is registered yet. The
// implementation mounts it in UnionAdminModule on the admin entry only, as union-pids.controller.ts:
// AdminOperationGuard with permission point union.account_auth (list, result and callback
// read-only without step-up; start and credential with a totp step-up consumed only after a 200),
// contract route schemas, and the contract's 20001 refusals.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard, CheckedRequest } from '../../../platform/index.ts';
import type { AdminUnionAccounts } from '../../application/admin-accounts.ts';

export interface AdminUnionAccountRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

export class AdminUnionAccountsController {
  constructor(guard: AdminOperationGuard, accounts: AdminUnionAccounts) {
    void guard;
    void accounts;
    throw new Error('NotImplemented: AdminUnionAccountsController');
  }

  list(request: AdminUnionAccountRequest): Promise<Schema<'AdminUnionAccountListResponse'>> {
    void request;
    throw new Error('NotImplemented: AdminUnionAccountsController.list');
  }

  start(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    body: Schema<'AdminUnionReauthorizeRequest'>,
  ): Promise<Schema<'AdminUnionReauthSessionResponse'>> {
    void request;
    void unionAccountId;
    void body;
    throw new Error('NotImplemented: AdminUnionAccountsController.start');
  }

  result(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    sessionId: string,
  ): Promise<Schema<'AdminUnionReauthResultResponse'>> {
    void request;
    void unionAccountId;
    void sessionId;
    throw new Error('NotImplemented: AdminUnionAccountsController.result');
  }

  callback(
    request: AdminUnionAccountRequest,
    body: Schema<'AdminUnionOAuthCallbackRequest'>,
  ): Promise<Schema<'AdminUnionReauthResultResponse'>> {
    void request;
    void body;
    throw new Error('NotImplemented: AdminUnionAccountsController.callback');
  }

  putCredential(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    body: Schema<'AdminUnionCredentialRequest'>,
  ): Promise<Schema<'AdminUnionAccountResponse'>> {
    void request;
    void unionAccountId;
    void body;
    throw new Error('NotImplemented: AdminUnionAccountsController.putCredential');
  }
}
