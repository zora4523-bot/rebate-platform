// /admin/v1/admins (F1-06m; contract operations adminListAdmins, adminGetAdmin): read-only admin
// accounts, super admin only. B1-34h adds the writes adminCreateAdmin,
// adminRegenerateAdminInitialPassword, adminDisableAdmin, adminEnableAdmin, adminResetAdminTotp
// (totp-tier step-up through the step-up gate: claimed before, consumed only by the 2xx answer)
// and adminUpdateAdminDisplayName (no step-up); B1-34k adds adminSaveAdminPermissions (totp-tier
// step-up, CAS on expected_row_version) and row_version on the reads; refusals are thrown inside
// the gate, so they keep the step-up token usable. The answers with a one-time initial password carry
// Cache-Control: no-store. The admin request check (application/admin-check.ts) has already
// verified the admin_token and refused any account that is not a super admin (10403
// admin_permission_denied) before the query schema ran; the handlers only take the parameters,
// call the use case and map its answer. Served by the admin entry only.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
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
import type {
  AccountAnswer,
  AdminAccountsWriter,
  AdminActor,
  CreatedAnswer,
} from '../../application/admin-accounts-write.ts';
import type { AdminStepUpGate } from '../../application/permission-guard.ts';
import { ADMIN_MESSAGES } from '../../application/admin-check.ts';
import {
  ADMIN_ACCOUNTS_READ,
  ADMIN_ACCOUNTS_WRITE,
  ADMIN_STEP_UP_GATE,
} from '../../application/tokens.ts';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_SIZE_DEFAULT } from '../../domain/admin-view.ts';

type PageResponse = Schema<'AdminAccountPageResponse'>;
type AccountResponse = Schema<'AdminAccountResponse'>;
type Account = Schema<'AdminAccount'>;
type CreatedResponse = Schema<'AdminCreatedAccountResponse'>;

/** Fallback text of 20902 (clients show their dictionary text error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface AdminsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Validated and coerced by the contract's route schema. */
  readonly query: { readonly page?: number; readonly page_size?: number };
  readonly params: { readonly admin_id?: string };
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

function principalOf(request: AdminsRequest): AdminPrincipal {
  const principal = adminPrincipal(request);
  // Unreachable behind the admin token check; never answer 200 for an unchecked request.
  if (principal === undefined) throw new Error('admin: admins read without a verified admin_token');
  return principal;
}

/** Reads and writes carry row_version, the CAS value of adminSaveAdminPermissions. */
function toAccount(view: AdminAccountView): Account {
  return {
    admin_id: view.adminId,
    username: view.username,
    // Omitted when never set (contract: clients then show username).
    ...(view.displayName === null ? {} : { display_name: view.displayName }),
    is_super: view.isSuper,
    status: view.status as Account['status'],
    totp_bound: view.totpBound,
    verify_phone_masked: view.verifyPhoneMasked,
    locked_until: view.lockedUntil === null ? null : view.lockedUntil.toISOString(),
    permissions: view.permissions,
    created_at: view.createdAt.toISOString(),
    row_version: view.rowVersion,
  };
}

function actorOf(request: AdminsRequest): AdminActor {
  const principal = principalOf(request);
  return {
    appId: principal.appId,
    adminId: principal.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** A refusal of the use case as the contract's error envelope (thrown inside the gate). */
function refused(
  answer: Exclude<AccountAnswer | CreatedAnswer, { kind: 'ok' }>,
  traceId: string,
): HttpException {
  if (answer.kind === 'fields') {
    const { statusCode, body } = fieldsErrorEnvelope(answer.fields, traceId);
    return new HttpException(body, statusCode);
  }
  if (answer.kind === 'forbidden') {
    return new HttpException(
      {
        code: 10403,
        msg: ADMIN_MESSAGES[10403].admin_permission_denied,
        data: { reason: 'admin_permission_denied' },
        trace_id: traceId,
      },
      403,
    );
  }
  return new HttpException(
    {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'admin_account' },
      trace_id: traceId,
    },
    409,
  );
}

@Controller('admin/v1/admins')
export class AdminAccountsController {
  constructor(
    @Inject(ADMIN_ACCOUNTS_READ) private readonly reader: AdminAccountsReader,
    @Inject(ADMIN_ACCOUNTS_WRITE) private readonly writer: AdminAccountsWriter,
    @Inject(ADMIN_STEP_UP_GATE) private readonly gate: AdminStepUpGate,
  ) {}

  /** Runs `write` behind the totp-tier step-up; a refusal is thrown (token stays usable). */
  private async stepped<T extends AccountResponse | CreatedResponse>(
    request: AdminsRequest,
    write: () => Promise<T>,
  ): Promise<T> {
    const principal = principalOf(request);
    let response: T | undefined;
    await this.gate.run(
      { principal, tier: 'totp', headers: request.headers, traceId: request.id },
      async () => {
        response = await write();
        return { statusCode: 200, body: response };
      },
    );
    if (response === undefined) throw new Error('admin: step-up gate returned without an answer');
    return response;
  }

  private account(request: AdminsRequest, answer: AccountAnswer): AccountResponse {
    if (answer.kind !== 'ok') throw refused(answer, request.id);
    return { code: 0, msg: '', data: toAccount(answer.account), trace_id: request.id };
  }

  private created(request: AdminsRequest, answer: CreatedAnswer): CreatedResponse {
    if (answer.kind !== 'ok') throw refused(answer, request.id);
    return {
      code: 0,
      msg: '',
      data: {
        account: toAccount(answer.account),
        initial_password: answer.initialPassword,
      },
      trace_id: request.id,
    };
  }

  private target(request: AdminsRequest): string {
    return request.params.admin_id ?? '';
  }

  /** adminCreateAdmin: an ordinary account on a one-time initial password (shown this once). */
  @Post()
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminCreateAdmin'))
  async create(
    @Req() request: AdminsRequest,
    @Body() body: Schema<'AdminCreateAdminRequest'>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<CreatedResponse> {
    reply.header('Cache-Control', 'no-store');
    return this.stepped(request, async () =>
      this.created(request, await this.writer.create(actorOf(request), body)),
    );
  }

  /** adminRegenerateAdminInitialPassword: a new one-time initial password (shown this once). */
  @Post(':admin_id/initial-password')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminRegenerateAdminInitialPassword'))
  async regenerate(
    @Req() request: AdminsRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<CreatedResponse> {
    reply.header('Cache-Control', 'no-store');
    return this.stepped(request, async () =>
      this.created(request, await this.writer.regenerate(actorOf(request), this.target(request))),
    );
  }

  /** adminDisableAdmin: disabled, credentials void, running exports cancelled. */
  @Post(':admin_id/disable')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminDisableAdmin'))
  async disable(
    @Req() request: AdminsRequest,
    @Body() body: Schema<'AdminReasonRequest'>,
  ): Promise<AccountResponse> {
    return this.stepped(request, async () =>
      this.account(
        request,
        await this.writer.disable(actorOf(request), this.target(request), body.reason),
      ),
    );
  }

  /** adminEnableAdmin: active again with the points it had. */
  @Post(':admin_id/enable')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminEnableAdmin'))
  async enable(@Req() request: AdminsRequest): Promise<AccountResponse> {
    return this.stepped(request, async () =>
      this.account(request, await this.writer.enable(actorOf(request), this.target(request))),
    );
  }

  /** adminResetAdminTotp: back to no bound authenticator, credentials void. */
  @Post(':admin_id/totp/reset')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminResetAdminTotp'))
  async resetTotp(
    @Req() request: AdminsRequest,
    @Body() body: Schema<'AdminReasonRequest'>,
  ): Promise<AccountResponse> {
    return this.stepped(request, async () =>
      this.account(
        request,
        await this.writer.resetTotp(actorOf(request), this.target(request), body.reason),
      ),
    );
  }

  /** adminUpdateAdminDisplayName: no step-up; sessions stay. */
  @Put(':admin_id/display-name')
  @RouteSchema(contractRouteSchema('adminUpdateAdminDisplayName'))
  async rename(
    @Req() request: AdminsRequest,
    @Body() body: Schema<'AdminDisplayNameUpdateRequest'>,
  ): Promise<AccountResponse> {
    return this.account(
      request,
      await this.writer.rename(actorOf(request), this.target(request), body.display_name),
    );
  }

  /** adminSaveAdminPermissions: the whole set of ticked points; sessions keep running on it. */
  @Put(':admin_id/permissions')
  @RouteSchema(contractRouteSchema('adminSaveAdminPermissions'))
  async savePermissions(
    @Req() request: AdminsRequest,
    @Body() body: Schema<'AdminPermissionsSaveRequest'>,
  ): Promise<AccountResponse> {
    return this.stepped(request, async () =>
      this.account(
        request,
        await this.writer.savePermissions(actorOf(request), this.target(request), body),
      ),
    );
  }

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
