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
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard } from '../../../platform/index.ts';
import type { AdminAssignDeps } from '../../application/admin-assign.ts';

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

export class AdminOrderAssignHttp {
  constructor(deps: AdminOrderAssignHttpDeps) {
    void deps;
    throw new Error('NotImplemented: AdminOrderAssignHttp');
  }

  async reassign(
    request: AdminAssignRequest,
    orderId: string,
    body: AdminAssignBody,
  ): Promise<Schema<'AdminOrderDetailResponse'>> {
    void request;
    void orderId;
    void body;
    throw new Error('NotImplemented: reassign');
  }
}
