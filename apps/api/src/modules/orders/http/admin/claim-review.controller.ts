// B1-10m: POST /admin/v1/claims/{claim_id}/items/{item_id}/approve and /reject (contract
// adminApproveClaimItem / adminRejectClaimItem; BR-ATTR-30, BR-ATTR-32). Only authorisation, the
// parameters and the call into application/claim-review.ts live here.
//
// Mounted only by OrdersAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the body before this runs; AdminOperationGuard re-reads the
// account and checks order.claim (step-up tier null). The use case writes the review and its audit
// record in one transaction, so a failing audit rolls the review back (50001). Without the database
// or the event bus the routes still register and every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { AdminOperationGuard, contractRouteSchema } from '../../../platform/index.ts';
import {
  approveClaimItem,
  rejectClaimItem,
  type ClaimReviewActor,
  type ClaimReviewDeps,
  type ClaimReviewResult,
} from '../../application/claim-review.ts';
import {
  ADMIN_WRITE_DEPS,
  conflictRefusal,
  fieldsRefusal,
  type AdminWriteDeps,
  type AdminWriteRequest,
  type HeaderReply,
} from './write-deps.ts';

type Detail = Schema<'AdminClaimDetailResponse'>;

export class AdminClaimReviewController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminWriteDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminWriteDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  approve(
    request: AdminWriteRequest,
    claimId: string,
    itemId: string,
    body: Schema<'AdminApproveClaimItemRequest'>,
    reply: HeaderReply,
  ): Promise<Detail> {
    return this.run(request, reply, (deps, actor) =>
      approveClaimItem(deps, actor, {
        claimId,
        itemId,
        expected_row_version: body.expected_row_version,
        reason: body.reason,
      }),
    );
  }

  reject(
    request: AdminWriteRequest,
    claimId: string,
    itemId: string,
    body: Schema<'AdminRejectClaimItemRequest'>,
    reply: HeaderReply,
  ): Promise<Detail> {
    return this.run(request, reply, (deps, actor) =>
      rejectClaimItem(deps, actor, {
        claimId,
        itemId,
        expected_row_version: body.expected_row_version,
        reason: body.reason,
        reject_reason: body.reject_reason,
      }),
    );
  }

  private async run(
    request: AdminWriteRequest,
    reply: HeaderReply,
    review: (deps: ClaimReviewDeps, actor: ClaimReviewActor) => Promise<ClaimReviewResult>,
  ): Promise<Detail> {
    reply.header('Cache-Control', 'no-store');
    let response: Detail | undefined;
    await this.#guard.run({ request, permission: 'order.claim' }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('orders: claim review needs the database and events');
      const outcome = await review(deps.claims, {
        appId: actor.appId,
        adminId: actor.adminId,
        ip: request.ip ?? null,
      });
      if (outcome.code === 20001) throw fieldsRefusal(outcome.data.fields, request.id);
      if (outcome.code === 20902) throw conflictRefusal(outcome.data.resource, request.id);
      response = { code: 0, msg: '', data: outcome.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as identity's and risk's admin controllers (no parameter decorators).
{
  const prototype = AdminClaimReviewController.prototype;
  Inject(AdminOperationGuard)(AdminClaimReviewController, undefined, 0);
  Inject(ADMIN_WRITE_DEPS)(AdminClaimReviewController, undefined, 1);
  for (const [name, operationId] of [
    ['approve', 'adminApproveClaimItem'],
    ['reject', 'adminRejectClaimItem'],
  ] as const) {
    const handler = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    Param('claim_id')(prototype, name, 1);
    Param('item_id')(prototype, name, 2);
    Body()(prototype, name, 3);
    Res({ passthrough: true })(prototype, name, 4);
    Post(`:claim_id/items/:item_id/${name}`)(prototype, name, handler);
    HttpCode(200)(prototype, name, handler);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, handler);
  }
  Controller('admin/v1/claims')(AdminClaimReviewController);
}
