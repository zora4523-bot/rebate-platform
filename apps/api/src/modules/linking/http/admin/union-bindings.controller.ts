// POST /admin/v1/users/{user_id}/union-bindings/{platform}/reset | disable | enable
// (adminResetUserUnionBinding / adminDisableUserUnionBinding / adminEnableUserUnionBinding;
// BR-ID-20, F1-07c). Mounted only by LinkingAdminModule on the admin entry. The admin request
// check has verified the admin_token and the route schema the body (reason 1–200,
// expected_row_version) before this runs; the operation guard checks the account, the permission
// point (reset: union.binding_reset; disable / enable: union.binding_disable) and its totp step-up,
// and consumes the step-up token only after a 200 with code 0. Refusals are thrown inside the
// guard so a refused change never uses up the token. No Idempotency-Key (04 §6.6): the
// row_version compare-and-set makes a repeat a 20902.
import {
  Body,
  Controller,
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
  AdminUnionBindingConflictError,
  AdminUnionBindingFieldsError,
  AdminUnionBindingNotAllowedError,
  AdminUnionBindings,
  type AdminBindingAction,
} from '../../application/admin-union-bindings.ts';

interface BindingRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

type ActionBody = Schema<'AdminUserUnionBindingActionRequest'>;
type ActionResponse = Schema<'AdminUserUnionBindingResponse'>;

/** specs/permissions.yaml: both points are of the totp tier. */
const PERMISSION: Readonly<Record<AdminBindingAction, string>> = {
  reset: 'union.binding_reset',
  disable: 'union.binding_disable',
  enable: 'union.binding_disable',
};

export class AdminUnionBindingsController {
  readonly #guard: AdminOperationGuard;
  readonly #bindings: AdminUnionBindings;

  constructor(guard: AdminOperationGuard, bindings: AdminUnionBindings) {
    this.#guard = guard;
    this.#bindings = bindings;
  }

  reset(request: BindingRequest, userId: string, platform: string, body: ActionBody) {
    return this.#run('reset', request, userId, platform, body);
  }

  disable(request: BindingRequest, userId: string, platform: string, body: ActionBody) {
    return this.#run('disable', request, userId, platform, body);
  }

  enable(request: BindingRequest, userId: string, platform: string, body: ActionBody) {
    return this.#run('enable', request, userId, platform, body);
  }

  async #run(
    action: AdminBindingAction,
    request: BindingRequest,
    userId: string,
    platform: string,
    body: ActionBody,
  ): Promise<ActionResponse> {
    let response: ActionResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION[action] }, async (actor) => {
      try {
        const data = await this.#bindings.apply({
          action,
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          userId,
          platform,
          reason: body.reason,
          expectedRowVersion: body.expected_row_version,
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('linking: admin guard returned without an answer');
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminUnionBindingFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AdminUnionBindingConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'union_binding' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AdminUnionBindingNotAllowedError) {
    return new HttpException(
      { code: 30154, msg: '该授权当前的状态不允许这项操作，请刷新后查看', trace_id: traceId },
      422,
    );
  }
  return error;
}

// Plain decorator calls, as identity's and content's admin controllers (no parameter decorators).
{
  const prototype = AdminUnionBindingsController.prototype;
  Inject(AdminOperationGuard)(AdminUnionBindingsController, undefined, 0);
  Inject(AdminUnionBindings)(AdminUnionBindingsController, undefined, 1);
  const routes = [
    ['reset', 'adminResetUserUnionBinding'],
    ['disable', 'adminDisableUserUnionBinding'],
    ['enable', 'adminEnableUserUnionBinding'],
  ] as const;
  for (const [action, operationId] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, action)!;
    Req()(prototype, action, 0);
    Param('user_id')(prototype, action, 1);
    Param('platform')(prototype, action, 2);
    Body()(prototype, action, 3);
    Post(`:user_id/union-bindings/:platform/${action}`)(prototype, action, descriptor);
    HttpCode(200)(prototype, action, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, action, descriptor);
  }
  Controller('admin/v1/users')(AdminUnionBindingsController);
}
