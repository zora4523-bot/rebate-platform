// B2-09b: POST /admin/v1/recon-diffs/{recon_diff_id}/close (closeAdminReconDiff; 08 BR-FUND-19,
// BR-FUND-22; 04 §11.2 fund.recon). Only authorisation, the parameters and the call into
// application/admin-recon-diff-close.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the body, the path and the Idempotency-Key header
// before this runs; the AdminOperationGuard re-reads the account and checks the permission point
// fund.recon (fund.view is not enough; a super admin holds every point; step-up tier null: no
// X-Step-Up-Token is read). Inside the guard the use case runs under platform idempotency (subject
// a:<admin_users.id>) and returns the exact bytes to send — the stored first answer on a replay —
// so the reply is written raw here, as payment's admin refunds do. Without the database or the
// idempotency primitive (isolated HTTP unit tests) the route still registers and every call fails
// closed (50001).
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
  closeAdminReconDiff,
  type CloseAdminReconDiffDeps,
} from '../../application/admin-recon-diff-close.ts';

/** Nest token of the use case dependencies (null in a process without database or idempotency). */
export const RECON_DIFF_CLOSE_DEPS = Symbol('LEDGER_RECON_DIFF_CLOSE_DEPS');

/** specs/permissions.yaml: fund.recon, step-up tier null. */
const PERMISSION = 'fund.recon';

export interface AdminReconDiffCloseRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminReconDiffCloseRawReply {
  code(statusCode: number): AdminReconDiffCloseRawReply;
  type(contentType: string): AdminReconDiffCloseRawReply;
  send(payload: string): unknown;
}

function header(request: AdminReconDiffCloseRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminReconDiffCloseController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: CloseAdminReconDiffDeps | null;

  constructor(guard: AdminOperationGuard, deps: CloseAdminReconDiffDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async close(
    request: AdminReconDiffCloseRequest,
    reconDiffId: string,
    body: Schema<'AdminReconDiffCloseRequest'>,
    reply: AdminReconDiffCloseRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('ledger: closing a recon diff needs the database and idempotency');
      }
      sent = await closeAdminReconDiff(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        reconDiffId,
        { body, key: header(request, 'idempotency-key'), traceId: request.id },
      );
      // The guard reads the code (no step-up for fund.recon); the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('ledger: admin guard returned without an answer');
    reply.code(sent.status).type('application/json; charset=utf-8').send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminReconDiffCloseController.prototype;
  Inject(AdminOperationGuard)(AdminReconDiffCloseController, undefined, 0);
  Inject(RECON_DIFF_CLOSE_DEPS)(AdminReconDiffCloseController, undefined, 1);

  const close = Object.getOwnPropertyDescriptor(prototype, 'close')!;
  Req()(prototype, 'close', 0);
  Param('recon_diff_id')(prototype, 'close', 1);
  Body()(prototype, 'close', 2);
  Res()(prototype, 'close', 3);
  Post('recon-diffs/:recon_diff_id/close')(prototype, 'close', close);
  HttpCode(200)(prototype, 'close', close);
  RouteSchema(contractRouteSchema('closeAdminReconDiff'))(prototype, 'close', close);

  Controller('admin/v1')(AdminReconDiffCloseController);
}
