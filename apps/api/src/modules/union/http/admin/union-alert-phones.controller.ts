// GET / POST / DELETE /admin/v1/union-accounts/alert-phones (B1-22g; adminListUnionAlertPhones /
// adminAddUnionAlertPhone / adminRemoveUnionAlertPhone; BR-ID-24 细则「后台告警手机号与重新授权会话」,
// D10-152 ④). Mounted only by UnionAdminModule on the admin entry, as union-accounts.controller.ts.
// The admin request check has verified the admin_token and the route schema the body / query
// before this runs; AdminOperationGuard checks the account and the permission point
// union.account_auth first, then (add / remove) the totp step-up on every call, whose token is
// consumed only after a 200 with code 0. Refusals are thrown inside the guard, so a refused change
// never uses up the token. No Idempotency-Key (contract).
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
} from '../../../platform/index.ts';
import {
  AdminUnionAlertPhonesConflictError,
  AdminUnionAlertPhonesFieldsError,
  AdminUnionAlertPhonesService,
  type AdminUnionAlertPhoneActor,
} from '../../application/admin-alert-phones.ts';
import type { AdminUnionAccountRequest } from './union-accounts.controller.ts';

/** DELETE query as the route schema delivers it. */
export interface AdminUnionAlertPhoneRemoveQuery {
  readonly phone_id: string;
  readonly expected_version: number;
}

/** specs/permissions.yaml: union.account_auth, totp tier. */
const PERMISSION = 'union.account_auth';
/** Fallback text of 20902 (clients show their dictionary text error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

type PhonesResponse = Schema<'AdminUnionAlertPhonesResponse'>;

export class AdminUnionAlertPhonesController {
  readonly #guard: AdminOperationGuard;
  readonly #phones: AdminUnionAlertPhonesService;

  constructor(guard: AdminOperationGuard, phones: AdminUnionAlertPhonesService) {
    this.#guard = guard;
    this.#phones = phones;
  }

  list(request: AdminUnionAccountRequest): Promise<PhonesResponse> {
    return this.#run(request, true, (actor) => this.#phones.list(actor));
  }

  add(
    request: AdminUnionAccountRequest,
    body: Schema<'AdminUnionAlertPhoneAddRequest'>,
  ): Promise<PhonesResponse> {
    return this.#run(request, false, (actor) => this.#phones.add(actor, body));
  }

  remove(
    request: AdminUnionAccountRequest,
    query: AdminUnionAlertPhoneRemoveQuery,
  ): Promise<PhonesResponse> {
    return this.#run(request, false, (actor) =>
      this.#phones.remove(actor, {
        phoneId: query.phone_id,
        expectedVersion: query.expected_version,
      }),
    );
  }

  async #run(
    request: AdminUnionAccountRequest,
    readOnly: boolean,
    work: (actor: AdminUnionAlertPhoneActor) => Promise<PhonesResponse['data']>,
  ): Promise<PhonesResponse> {
    let response: PhonesResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly }, async (actor) => {
      try {
        const data = await work(actorOf(actor, request));
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('union: admin guard returned without an answer');
    return response;
  }
}

function actorOf(actor: AdminActor, request: AdminUnionAccountRequest): AdminUnionAlertPhoneActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminUnionAlertPhonesFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    const body =
      error.reason === null
        ? refused.body
        : { ...refused.body, data: { ...refused.body.data, reason: error.reason } };
    return new HttpException(body, refused.statusCode);
  }
  if (error instanceof AdminUnionAlertPhonesConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: CONFLICT_MESSAGE,
        data: { resource: 'config_item' },
        trace_id: traceId,
      },
      409,
    );
  }
  return error;
}

// Plain decorator calls, as union-accounts.controller.ts (no parameter decorators).
{
  const prototype = AdminUnionAlertPhonesController.prototype;
  const descriptor = (name: 'list' | 'add' | 'remove') =>
    Object.getOwnPropertyDescriptor(prototype, name)!;
  Inject(AdminOperationGuard)(AdminUnionAlertPhonesController, undefined, 0);
  Inject(AdminUnionAlertPhonesService)(AdminUnionAlertPhonesController, undefined, 1);

  const list = descriptor('list');
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  HttpCode(200)(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnionAlertPhones'))(prototype, 'list', list);

  const add = descriptor('add');
  Req()(prototype, 'add', 0);
  Body()(prototype, 'add', 1);
  Post()(prototype, 'add', add);
  HttpCode(200)(prototype, 'add', add);
  RouteSchema(contractRouteSchema('adminAddUnionAlertPhone'))(prototype, 'add', add);

  const remove = descriptor('remove');
  Req()(prototype, 'remove', 0);
  Query()(prototype, 'remove', 1);
  Delete()(prototype, 'remove', remove);
  HttpCode(200)(prototype, 'remove', remove);
  RouteSchema(contractRouteSchema('adminRemoveUnionAlertPhone'))(prototype, 'remove', remove);

  Controller('admin/v1/union-accounts/alert-phones')(AdminUnionAlertPhonesController);
}
