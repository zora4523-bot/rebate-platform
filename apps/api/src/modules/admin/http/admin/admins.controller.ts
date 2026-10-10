// /admin/v1/admins (F1-06m; contract operations adminListAdmins, adminGetAdmin): read-only admin
// accounts, super admin only. The admin request check (application/admin-check.ts) has already
// verified the admin_token and refused any account that is not a super admin (10403
// admin_permission_denied) before the query schema ran; the handlers only take the parameters,
// call the use case and map its answer. Served by the admin entry only.
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type {
  AdminAccountView,
  AdminAccountsReader,
} from '../../application/admin-accounts-read.ts';
import { ADMIN_ACCOUNTS_READ } from '../../application/tokens.ts';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_SIZE_DEFAULT } from '../../domain/admin-view.ts';

type PageResponse = Schema<'AdminAccountPageResponse'>;
type AccountResponse = Schema<'AdminAccountResponse'>;
type Account = Schema<'AdminAccount'>;

interface AdminsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Validated and coerced by the contract's route schema. */
  readonly query: { readonly page?: number; readonly page_size?: number };
  readonly params: { readonly admin_id?: string };
}

function principalOf(request: AdminsRequest): AdminPrincipal {
  const principal = adminPrincipal(request);
  // Unreachable behind the admin token check; never answer 200 for an unchecked request.
  if (principal === undefined) throw new Error('admin: admins read without a verified admin_token');
  return principal;
}

function toAccount(view: AdminAccountView): Account {
  return {
    admin_id: view.adminId,
    username: view.username,
    is_super: view.isSuper,
    status: view.status as Account['status'],
    totp_bound: view.totpBound,
    verify_phone_masked: view.verifyPhoneMasked,
    locked_until: view.lockedUntil === null ? null : view.lockedUntil.toISOString(),
    permissions: view.permissions,
    created_at: view.createdAt.toISOString(),
  };
}

@Controller('admin/v1/admins')
export class AdminAccountsController {
  constructor(@Inject(ADMIN_ACCOUNTS_READ) private readonly reader: AdminAccountsReader) {}

  /** adminListAdmins: one page of the app's admin accounts (created_at, then id ascending). */
  @Get()
  @RouteSchema(contractRouteSchema('adminListAdmins'))
  async list(@Req() request: AdminsRequest): Promise<PageResponse> {
    const principal = principalOf(request);
    const result = await this.reader.list(
      principal.appId,
      request.query.page ?? ADMIN_PAGE_DEFAULT,
      request.query.page_size ?? ADMIN_PAGE_SIZE_DEFAULT,
    );
    return {
      code: 0,
      msg: '',
      data: {
        items: result.items.map(toAccount),
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
      },
      trace_id: request.id,
    };
  }

  /** adminGetAdmin: one account of the app; unknown, malformed or foreign id → 20001 admin_id. */
  @Get(':admin_id')
  @RouteSchema(contractRouteSchema('adminGetAdmin'))
  async get(@Req() request: AdminsRequest): Promise<AccountResponse> {
    const principal = principalOf(request);
    const view = await this.reader.get(principal.appId, request.params.admin_id ?? '');
    if (view === undefined) {
      const { statusCode, body } = fieldsErrorEnvelope(['admin_id'], request.id);
      throw new HttpException(body, statusCode);
    }
    return { code: 0, msg: '', data: toAccount(view), trace_id: request.id };
  }
}
