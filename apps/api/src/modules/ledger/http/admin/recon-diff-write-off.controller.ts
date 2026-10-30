// B2-07e: POST /admin/v1/recon-diffs/{recon_diff_id}/write-off (writeOffAdminReconDiff; 08
// BR-WDR-23 ③, BR-WDR-08 W11; 04 §11.2 payout.execute, step-up tier totp). Only authorisation, the
// parameters and the call into application/admin-recon-diff-write-off.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account, checks payout.execute and the totp-tier X-Step-Up-Token (10003 data.tier=totp);
// inside the guard the use case runs under platform idempotency (subject a:<admin_users.id>) and
// returns the exact bytes to send, written raw here as the close controller does. Without the
// database or the idempotency primitive the route still registers and every call fails closed.
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
  writeOffAdminReconDiff,
  type WriteOffAdminReconDiffDeps,
} from '../../application/admin-recon-diff-write-off.ts';

/** Nest token of the use case dependencies (null in a process without database, queue or idempotency). */
export const RECON_DIFF_WRITE_OFF_DEPS = Symbol('LEDGER_RECON_DIFF_WRITE_OFF_DEPS');

/** specs/permissions.yaml: payout.execute, step-up tier totp (read by the guard). */
const PERMISSION = 'payout.execute';

export interface AdminReconDiffWriteOffRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminReconDiffWriteOffRawReply {
  code(statusCode: number): AdminReconDiffWriteOffRawReply;
  type(contentType: string): AdminReconDiffWriteOffRawReply;
  send(payload: string): unknown;
}

function header(request: AdminReconDiffWriteOffRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminReconDiffWriteOffController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: WriteOffAdminReconDiffDeps | null;

  constructor(guard: AdminOperationGuard, deps: WriteOffAdminReconDiffDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async writeOff(
    request: AdminReconDiffWriteOffRequest,
    reconDiffId: string,
    body: Schema<'AdminReconDiffWriteOffRequest'>,
    reply: AdminReconDiffWriteOffRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error(
          'ledger: writing off a recon diff needs the database, queue and idempotency',
        );
      }
      sent = await writeOffAdminReconDiff(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        reconDiffId,
        { body, key: header(request, 'idempotency-key'), traceId: request.id },
      );
      // The guard reads the code (it consumed the totp step-up token); the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('ledger: admin guard returned without an answer');
    reply.code(sent.status).type('application/json; charset=utf-8').send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminReconDiffWriteOffController.prototype;
  Inject(AdminOperationGuard)(AdminReconDiffWriteOffController, undefined, 0);
  Inject(RECON_DIFF_WRITE_OFF_DEPS)(AdminReconDiffWriteOffController, undefined, 1);

  const writeOff = Object.getOwnPropertyDescriptor(prototype, 'writeOff')!;
  Req()(prototype, 'writeOff', 0);
  Param('recon_diff_id')(prototype, 'writeOff', 1);
  Body()(prototype, 'writeOff', 2);
  Res()(prototype, 'writeOff', 3);
  Post('recon-diffs/:recon_diff_id/write-off')(prototype, 'writeOff', writeOff);
  HttpCode(200)(prototype, 'writeOff', writeOff);
  RouteSchema(contractRouteSchema('writeOffAdminReconDiff'))(prototype, 'writeOff', writeOff);

  Controller('admin/v1')(AdminReconDiffWriteOffController);
}
