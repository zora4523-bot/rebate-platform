// B2-09g: POST /admin/v1/recon-diffs/{recon_diff_id}/restore (restoreAdminReconDiff; 08 BR-FUND-22
// ③; 04 §11.2 order.restore, step-up tier totp). Only authorisation, the parameters and the call
// into application/admin-recon-restore.ts live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The AdminOperationGuard
// re-reads the account, checks order.restore (a super admin holds every point) and the totp-tier
// X-Step-Up-Token (10003 data.tier=totp); inside the guard the use case runs under platform
// idempotency (subject a:<admin_users.id>) and returns the exact bytes to send, written raw here.
// Without the database, the event bus or the idempotency primitive the route still registers and
// every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  restoreAdminReconDiff,
  type RestoreAdminReconDiffDeps,
} from '../../application/admin-recon-restore.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_RECON_RESTORE = Symbol('SETTLEMENT_ADMIN_RECON_RESTORE');

/** specs/permissions.yaml: order.restore, step-up tier totp (read by the guard). */
const PERMISSION = 'order.restore';

export interface AdminReconRestoreRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminReconRestoreRawReply {
  header(name: string, value: string): AdminReconRestoreRawReply;
  code(statusCode: number): AdminReconRestoreRawReply;
  type(contentType: string): AdminReconRestoreRawReply;
  send(payload: string): unknown;
}

function header(request: AdminReconRestoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminReconRestoreController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: RestoreAdminReconDiffDeps | null;

  constructor(guard: AdminOperationGuard, deps: RestoreAdminReconDiffDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async restore(
    request: AdminReconRestoreRequest,
    reconDiffId: string,
    body: Schema<'AdminReconDiffRestoreRequest'>,
    reply: AdminReconRestoreRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: restoring a recon diff needs the database and idempotency');
      }
      sent = await restoreAdminReconDiff(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        reconDiffId,
        { body, key: header(request, 'idempotency-key'), traceId: request.id },
      );
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
  const prototype = AdminReconRestoreController.prototype;
  Inject(AdminOperationGuard)(AdminReconRestoreController, undefined, 0);
  Inject(ADMIN_RECON_RESTORE)(AdminReconRestoreController, undefined, 1);

  const restore = Object.getOwnPropertyDescriptor(prototype, 'restore')!;
  Req()(prototype, 'restore', 0);
  Param('recon_diff_id')(prototype, 'restore', 1);
  Body()(prototype, 'restore', 2);
  Res()(prototype, 'restore', 3);
  Post('recon-diffs/:recon_diff_id/restore')(prototype, 'restore', restore);
  HttpCode(200)(prototype, 'restore', restore);
  RouteSchema(contractRouteSchema('restoreAdminReconDiff'))(prototype, 'restore', restore);

  Controller('admin/v1')(AdminReconRestoreController);
}
