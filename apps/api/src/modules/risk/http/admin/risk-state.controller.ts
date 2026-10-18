// PUT /admin/v1/users/{user_id}/risk-state (adminUpdateUserRiskState; BR-ID-31, F1-07d). Mounted
// only by RiskAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the body before this runs; the operation guard checks the
// account, the permission point (ban / unban: risk.ban; freeze / unfreeze: risk.freeze) and its
// totp step-up, and consumes the step-up token only after a 200 with code 0. Refusals are thrown
// inside the guard so a refused change never uses up the token. No Idempotency-Key (04 §6.6): the
// row_version compare-and-set makes a repeat a 20902.
import { Body, Controller, HttpCode, HttpException, Inject, Param, Put, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminRiskState,
  AdminRiskStateFieldsError,
  AdminRiskStateNotAllowedError,
} from '../../application/admin-risk-state.ts';
import { RiskStateConflictError, RiskStateTransitionError } from '../../application/risk-state.ts';

interface RiskStateRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

type UpdateBody = Schema<'AdminUserRiskStateUpdateRequest'>;
type UpdateResponse = Schema<'AdminUserRiskStateResponse'>;

/** specs/permissions.yaml: both points are of the totp tier. */
function permissionOf(action: unknown): string {
  return action === 'ban' || action === 'unban' ? 'risk.ban' : 'risk.freeze';
}

export class AdminRiskStateController {
  readonly #guard: AdminOperationGuard;
  readonly #service: AdminRiskState;

  constructor(guard: AdminOperationGuard, service: AdminRiskState) {
    this.#guard = guard;
    this.#service = service;
  }

  async update(
    request: RiskStateRequest,
    userId: string,
    body: UpdateBody,
  ): Promise<UpdateResponse> {
    let response: UpdateResponse | undefined;
    await this.#guard.run({ request, permission: permissionOf(body.action) }, async (actor) => {
      try {
        const data = await this.#service.apply({
          appId: actor.appId,
          userId,
          adminId: actor.adminId,
          adminUsername: actor.loginName,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          body,
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('risk: admin guard returned without an answer');
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminRiskStateFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof RiskStateConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'user_risk_state' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AdminRiskStateNotAllowedError || error instanceof RiskStateTransitionError) {
    return new HttpException(
      { code: 44004, msg: '用户当前的风控状态不允许这项操作，请刷新后查看', trace_id: traceId },
      403,
    );
  }
  return error;
}

// Plain decorator calls, as linking's and identity's admin controllers (no parameter decorators).
{
  const prototype = AdminRiskStateController.prototype;
  Inject(AdminOperationGuard)(AdminRiskStateController, undefined, 0);
  Inject(AdminRiskState)(AdminRiskStateController, undefined, 1);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'update')!;
  Req()(prototype, 'update', 0);
  Param('user_id')(prototype, 'update', 1);
  Body()(prototype, 'update', 2);
  Put(':user_id/risk-state')(prototype, 'update', descriptor);
  HttpCode(200)(prototype, 'update', descriptor);
  RouteSchema(contractRouteSchema('adminUpdateUserRiskState'))(prototype, 'update', descriptor);
  Controller('admin/v1/users')(AdminRiskStateController);
}
