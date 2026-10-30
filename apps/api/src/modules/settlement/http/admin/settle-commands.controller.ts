// B2-09f: the five writes of the settlement console (CT-24zd): POST
// /admin/v1/settle-bills/{bill_id}/confirm, /admin/v1/settle-bills/{bill_id}/supplement-batches and
// /admin/v1/settle-batches/{batch_id}/cancel-schedule, /reject, /resume. Only authorisation, the
// parameters and the call into application/admin-settle-commands.ts live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the body, the path and the headers before this
// runs; the AdminOperationGuard re-reads the account and checks the permission point settle.bill
// (fund.view is not enough; a super admin holds every point) and the step-up tier totp. The use
// cases return the exact bytes to send (the stored first answer on a replayed launch), so the reply
// is written raw here; the token is consumed only on code 0. Without the database or the
// idempotency primitive (isolated HTTP unit tests) the routes still register and every call fails
// closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  cancelAdminSettleBatchSchedule,
  confirmAdminSettleBill,
  launchAdminSettleSupplement,
  rejectAdminSettleBatch,
  resumeAdminSettleBatch,
  type AdminSettleAnswer,
  type AdminSettleCommandDeps,
  type AdminSettleOperator,
} from '../../application/admin-settle-commands.ts';

/** Nest token of the use case dependencies (null in a process without database or idempotency). */
export const ADMIN_SETTLE_COMMANDS = Symbol('SETTLEMENT_ADMIN_SETTLE_COMMANDS');

/** specs/permissions.yaml: settle.bill, step-up tier totp. */
const PERMISSION = 'settle.bill';

export interface AdminSettleCommandRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the use case's exact bytes). */
export interface AdminSettleCommandRawReply {
  header(name: string, value: string): AdminSettleCommandRawReply;
  code(statusCode: number): AdminSettleCommandRawReply;
  type(contentType: string): AdminSettleCommandRawReply;
  send(payload: string): unknown;
}

function header(request: AdminSettleCommandRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminSettleCommandsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminSettleCommandDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminSettleCommandDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  confirm(
    request: AdminSettleCommandRequest,
    billId: string,
    body: Schema<'AdminSettleBillConfirmRequest'>,
    reply: AdminSettleCommandRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      confirmAdminSettleBill(deps, operator, billId, body, request.id),
    );
  }

  supplement(
    request: AdminSettleCommandRequest,
    billId: string,
    body: Schema<'AdminSettleSupplementRequest'>,
    reply: AdminSettleCommandRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      launchAdminSettleSupplement(deps, operator, billId, {
        body,
        key: header(request, 'idempotency-key'),
        traceId: request.id,
      }),
    );
  }

  cancelSchedule(
    request: AdminSettleCommandRequest,
    batchId: string,
    body: Schema<'AdminSettleBatchVersionRequest'>,
    reply: AdminSettleCommandRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      cancelAdminSettleBatchSchedule(deps, operator, batchId, body, request.id),
    );
  }

  reject(
    request: AdminSettleCommandRequest,
    batchId: string,
    body: Schema<'AdminSettleBatchRejectRequest'>,
    reply: AdminSettleCommandRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      rejectAdminSettleBatch(deps, operator, batchId, body, request.id),
    );
  }

  resume(
    request: AdminSettleCommandRequest,
    batchId: string,
    body: Schema<'AdminSettleBatchVersionRequest'>,
    reply: AdminSettleCommandRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      resumeAdminSettleBatch(deps, operator, batchId, body, request.id),
    );
  }

  async #write(
    request: AdminSettleCommandRequest,
    reply: AdminSettleCommandRawReply,
    work: (
      deps: AdminSettleCommandDeps,
      operator: AdminSettleOperator,
    ) => Promise<AdminSettleAnswer>,
  ): Promise<void> {
    let sent: AdminSettleAnswer | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: admin settle commands need the database and idempotency');
      }
      sent = await work(deps, {
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      });
      // The guard reads the code and consumes the step-up token on 0; the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('settlement: admin guard returned without an answer');
    reply
      .header('Cache-Control', 'no-store')
      .code(sent.status)
      .type('application/json; charset=utf-8')
      .send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminSettleCommandsController.prototype;
  Inject(AdminOperationGuard)(AdminSettleCommandsController, undefined, 0);
  Inject(ADMIN_SETTLE_COMMANDS)(AdminSettleCommandsController, undefined, 1);

  const route = (
    method: 'confirm' | 'supplement' | 'cancelSchedule' | 'reject' | 'resume',
    param: string,
    path: string,
    operationId: Parameters<typeof contractRouteSchema>[0],
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    Req()(prototype, method, 0);
    Param(param)(prototype, method, 1);
    Body()(prototype, method, 2);
    Res()(prototype, method, 3);
    Post(path)(prototype, method, descriptor);
    HttpCode(200)(prototype, method, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, method, descriptor);
  };
  route('confirm', 'bill_id', 'settle-bills/:bill_id/confirm', 'confirmAdminSettleBill');
  route(
    'supplement',
    'bill_id',
    'settle-bills/:bill_id/supplement-batches',
    'createAdminSettleSupplementBatches',
  );
  route(
    'cancelSchedule',
    'batch_id',
    'settle-batches/:batch_id/cancel-schedule',
    'cancelAdminSettleBatchSchedule',
  );
  route('reject', 'batch_id', 'settle-batches/:batch_id/reject', 'rejectAdminSettleBatch');
  route('resume', 'batch_id', 'settle-batches/:batch_id/resume', 'resumeAdminSettleBatch');

  Controller('admin/v1')(AdminSettleCommandsController);
}
