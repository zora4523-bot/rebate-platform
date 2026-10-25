// POST / GET /admin/v1/users/{user_id}/data-exports (adminCreateUserDataExport /
// adminListUserDataExports, CT-24q; 08 BR-ID-40; B1-27c). Mounted only by IdentityAdminModule on the
// admin entry. The admin request check has verified the admin_token and the contract route schema
// the params, body and query before these run (20001 data.fields); the operation guard checks the
// account, user.data_export and — registration only — its totp step-up, consumed only after a 200
// with code 0. Refusals are thrown inside the guard so a refused registration never uses up the
// step-up token (its audit record is already committed by the use case). No Idempotency-Key
// (04 §6.6): a retry returns the unfinished request with reused=true.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  ADMIN_DATA_COPIES,
  type AdminDataCopies,
  type AdminDataCopyRegisterResult,
  type AdminDataCopyView,
} from '../../application/admin-data-copies.ts';

interface DataExportsRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
  /** Validated and coerced by the contract's route schema. */
  readonly query: { readonly page?: number; readonly page_size?: number };
}

type CreateBody = Schema<'AdminUserDataExportCreateRequest'>;
type CreateResponse = Schema<'AdminUserDataExportCreateResponse'>;
type PageResponse = Schema<'AdminUserDataExportPageResponse'>;
type Listed = Schema<'AdminUserDataExport'>;

/** specs/permissions.yaml: totp tier. */
const PERMISSION = 'user.data_export';
const PAGE_DEFAULT = 1;
const PAGE_SIZE_DEFAULT = 20;

/** Statuses of contracts/error-codes.yaml and the texts of contracts/texts.default.json. */
const MSG_30419 = '该用户当前不受理这项代办';
const MSG_10403 = '当前账号没有这项操作的权限，请联系超级管理员开通';

function ipOf(request: DataExportsRequest): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function itemOf(view: AdminDataCopyView): Listed {
  return {
    export_id: view.exportId,
    user_id: view.userId,
    delivery: view.delivery,
    status: view.status,
    requested_by: view.requestedBy,
    requested_by_name: view.requestedByName,
    created_at: view.createdAt.toISOString(),
    due_at: view.dueAt.toISOString(),
    retry_of: view.retryOf,
    generated_at: iso(view.generatedAt),
    delivered_at: iso(view.deliveredAt),
    expires_at: iso(view.expiresAt),
    failure_reason: view.failureReason,
  };
}

function rejected(
  result: Exclude<AdminDataCopyRegisterResult, { kind: 'registered' }>,
  traceId: string,
): HttpException {
  const fields = (names: string[]) => {
    const refused = fieldsErrorEnvelope(names, traceId);
    return new HttpException(refused.body, refused.statusCode);
  };
  const deferred = (data: Record<string, string>) =>
    new HttpException({ code: 30419, msg: MSG_30419, data, trace_id: traceId }, 422);
  switch (result.kind) {
    case 'unknown_user':
      return fields(['user_id']);
    case 'phone_missing':
      return fields(['phone_sms_ok']);
    case 'account_deleting':
      return deferred({ reason: 'account_deleting', stage: 'processing' });
    case 'account_deleted':
      return deferred({ reason: 'account_deleted' });
    case 'delivery_undecided':
      return deferred({ reason: 'delivery_undecided' });
    case 'permission_denied':
      return new HttpException(
        {
          code: 10403,
          msg: MSG_10403,
          data: { reason: 'admin_permission_denied' },
          trace_id: traceId,
        },
        403,
      );
  }
}

function answered<T>(response: T | undefined): T {
  if (response === undefined) throw new Error('identity: admin guard returned without an answer');
  return response;
}

export class AdminUserDataExportsController {
  readonly #guard: AdminOperationGuard;
  readonly #copies: AdminDataCopies;

  constructor(guard: AdminOperationGuard, copies: AdminDataCopies) {
    this.#guard = guard;
    this.#copies = copies;
  }

  async create(
    request: DataExportsRequest,
    userId: string,
    body: CreateBody,
  ): Promise<CreateResponse> {
    let response: CreateResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const result = await this.#copies.register({
        appId: actor.appId,
        adminId: actor.adminId,
        userId,
        reason: body.reason,
        appLoginOk: body.app_login_ok,
        phoneSmsOk: body.phone_sms_ok,
        ip: ipOf(request),
      });
      if (result.kind !== 'registered') throw rejected(result, request.id);
      response = {
        code: 0,
        msg: '',
        data: { ...itemOf(result.view), reused: result.reused },
        trace_id: request.id,
      };
      return { statusCode: 200, body: response };
    });
    return answered(response);
  }

  async list(request: DataExportsRequest, userId: string): Promise<PageResponse> {
    let response: PageResponse | undefined;
    const page = request.query.page ?? PAGE_DEFAULT;
    const pageSize = request.query.page_size ?? PAGE_SIZE_DEFAULT;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      const result = await this.#copies.list({ appId: actor.appId, userId, page, pageSize });
      if (result.kind !== 'page') throw rejected(result, request.id);
      response = {
        code: 0,
        msg: '',
        data: { items: result.items.map(itemOf), page, page_size: pageSize, total: result.total },
        trace_id: request.id,
      };
      return { statusCode: 200, body: response };
    });
    return answered(response);
  }
}

// Plain decorator calls, as the other identity admin controllers.
{
  const prototype = AdminUserDataExportsController.prototype;
  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Inject(AdminOperationGuard)(AdminUserDataExportsController, undefined, 0);
  Inject(ADMIN_DATA_COPIES)(AdminUserDataExportsController, undefined, 1);
  Req()(prototype, 'create', 0);
  Param('user_id')(prototype, 'create', 1);
  Body()(prototype, 'create', 2);
  Post(':user_id/data-exports')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateUserDataExport'))(prototype, 'create', create);
  Req()(prototype, 'list', 0);
  Param('user_id')(prototype, 'list', 1);
  Get(':user_id/data-exports')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUserDataExports'))(prototype, 'list', list);
  Controller('admin/v1/users')(AdminUserDataExportsController);
}
