// B1-10f: the handler of POST /admin/v1/orders/{order_id}/reassign (contract adminReassignOrder).
// Not mounted (J-1): no Nest decorator here and no route on any entry; the mounting task wraps this
// in the admin controller. The admin request check has verified the admin token (and, once mounted,
// the route schema the body) before this runs.
//
// The operation guard checks the account, permission point order.assign and its totp step-up tier
// (X-Step-Up-Token) first; only inside its callback does the use case (application/admin-assign.ts)
// run, with the guard's actor and request.ip. A refusal is thrown inside the callback as an error
// envelope (so the guard consumes no step-up token): 20001 is HTTP 400 with data.fields (and
// data.reason for a target that cannot be the attribution target), 20902 is HTTP 409 with
// data.resource=order_attribution. Success: HTTP 200 { code 0, data <the order detail> }.
import { HttpException } from '@nestjs/common';
import type { Schema } from '@couli/contracts-ts';
import { fieldsErrorEnvelope, type AdminOperationGuard } from '../../../platform/index.ts';
import {
  assignOrder,
  type AdminAssignDeps,
  type AdminAssignOutcome,
} from '../../application/admin-assign.ts';

/** Any admin request: its id is the trace id; headers carry X-Step-Up-Token for the guard. */
export interface AdminAssignRequest {
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The request body (AdminOrderReassignRequest). */
export interface AdminAssignBody {
  readonly user_id: string;
  readonly expected_user_id: null;
  readonly expected_locked: boolean;
  readonly reason: string;
}

export interface AdminOrderAssignHttpDeps {
  readonly guard: Pick<AdminOperationGuard, 'run'>;
  readonly assign: AdminAssignDeps;
}

type Detail = Schema<'AdminOrderDetailResponse'>;

/** The error envelope of a refusal of the use case (thrown inside the guard callback). */
function refusal(outcome: Exclude<AdminAssignOutcome, { code: 0 }>, traceId: string) {
  if (outcome.code === 20902) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: outcome.data.resource },
        trace_id: traceId,
      },
      409,
    );
  }
  const refused = fieldsErrorEnvelope(outcome.data.fields, traceId);
  const body =
    outcome.data.reason === undefined
      ? refused.body
      : { ...refused.body, data: { ...refused.body.data, reason: outcome.data.reason } };
  return new HttpException(body, refused.statusCode);
}

export class AdminOrderAssignHttp {
  readonly #deps: AdminOrderAssignHttpDeps;

  constructor(deps: AdminOrderAssignHttpDeps) {
    this.#deps = deps;
  }

  async reassign(
    request: AdminAssignRequest,
    orderId: string,
    body: AdminAssignBody,
  ): Promise<Detail> {
    let response: Detail | undefined;
    await this.#deps.guard.run({ request, permission: 'order.assign' }, async (actor) => {
      const outcome = await assignOrder(
        this.#deps.assign,
        { appId: actor.appId, adminId: actor.adminId, ip: request.ip ?? null },
        {
          orderId,
          user_id: body.user_id,
          expected_user_id: body.expected_user_id,
          expected_locked: body.expected_locked,
          reason: body.reason,
        },
      );
      if (outcome.code !== 0) throw refusal(outcome, request.id);
      response = { code: 0, msg: '', data: outcome.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }
}
