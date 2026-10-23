// GET /admin/v1/union-accounts, POST /admin/v1/union-accounts/{union_account_id}/reauthorize,
// GET /admin/v1/union-accounts/{union_account_id}/reauthorize/{session_id}, POST
// /admin/v1/union-accounts/oauth/callback, PUT /admin/v1/union-accounts/{union_account_id}/credential
// (B1-22d; adminListUnionAccounts / adminStartUnionReauthorization / adminGetUnionReauthorization /
// adminCompleteUnionReauthorization / adminPutUnionCredential; BR-ID-24 ③, D10-176, D10-196).
//
// Mounted only by UnionAdminModule on the admin entry, as union-pids.controller.ts. The admin
// request check has verified the admin_token and the route schema the JSON bodies before this
// runs; AdminOperationGuard checks the account and the permission point union.account_auth
// (list, result and callback read-only, without step-up; start and credential with the totp
// step-up, whose token is consumed only after a 200 with code 0). Refusals are thrown inside the
// guard, so a refused change never uses up the token. No Idempotency-Key (contract).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminUnionAccountFieldsError,
  AdminUnionAccounts,
  type AdminUnionAccountActor,
} from '../../application/admin-accounts.ts';

export interface AdminUnionAccountRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

/** specs/permissions.yaml: union.account_auth, totp tier. */
const PERMISSION = 'union.account_auth';

export class AdminUnionAccountsController {
  readonly #guard: AdminOperationGuard;
  readonly #accounts: AdminUnionAccounts;

  constructor(guard: AdminOperationGuard, accounts: AdminUnionAccounts) {
    this.#guard = guard;
    this.#accounts = accounts;
  }

  list(request: AdminUnionAccountRequest): Promise<Schema<'AdminUnionAccountListResponse'>> {
    return this.#run(request, true, async (actor) => ({
      items: await this.#accounts.list(actor.appId),
    }));
  }

  start(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    body: Schema<'AdminUnionReauthorizeRequest'>,
  ): Promise<Schema<'AdminUnionReauthSessionResponse'>> {
    return this.#run(request, false, (actor) => this.#accounts.start(actor, unionAccountId, body));
  }

  result(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    sessionId: string,
  ): Promise<Schema<'AdminUnionReauthResultResponse'>> {
    return this.#run(request, true, (actor) =>
      this.#accounts.result(actor, unionAccountId, sessionId),
    );
  }

  callback(
    request: AdminUnionAccountRequest,
    body: Schema<'AdminUnionOAuthCallbackRequest'>,
  ): Promise<Schema<'AdminUnionReauthResultResponse'>> {
    // No step-up: the start required one and the state is single use (contract).
    return this.#run(request, true, (actor) => this.#accounts.callback(actor, body));
  }

  putCredential(
    request: AdminUnionAccountRequest,
    unionAccountId: string,
    body: Schema<'AdminUnionCredentialRequest'>,
  ): Promise<Schema<'AdminUnionAccountResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#accounts.putCredential(actor, unionAccountId, body),
    );
  }

  async #run<T>(
    request: AdminUnionAccountRequest,
    readOnly: boolean,
    work: (actor: AdminUnionAccountActor) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
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

function actorOf(actor: AdminActor, request: AdminUnionAccountRequest): AdminUnionAccountActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminUnionAccountFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    const body =
      error.reason === null
        ? refused.body
        : { ...refused.body, data: { ...refused.body.data, reason: error.reason } };
    return new HttpException(body, refused.statusCode);
  }
  return error;
}

/**
 * The contract schema of adminCompleteUnionReauthorization without the body's `minProperties` /
 * `maxProperties`: with ajv's allErrors a body lacking `state` would also be reported as [body],
 * and neither or both of `code` / `error` as [body], while the contract answers 20001 [state]
 * and [code] for them. AdminUnionAccounts.callback refuses those with the contract's fields.
 */
function callbackRouteSchema(): ReturnType<
  typeof contractRouteSchema<'adminCompleteUnionReauthorization'>
> {
  const schema = structuredClone(contractRouteSchema('adminCompleteUnionReauthorization'));
  const body = (schema as { body?: Record<string, unknown> }).body;
  if (body !== undefined) {
    delete body['minProperties'];
    delete body['maxProperties'];
  }
  return schema;
}

// Plain decorator calls, as union-pids.controller.ts (no parameter decorators).
{
  const prototype = AdminUnionAccountsController.prototype;
  const descriptor = (name: 'list' | 'start' | 'result' | 'callback' | 'putCredential') =>
    Object.getOwnPropertyDescriptor(prototype, name)!;
  Inject(AdminOperationGuard)(AdminUnionAccountsController, undefined, 0);
  Inject(AdminUnionAccounts)(AdminUnionAccountsController, undefined, 1);

  const list = descriptor('list');
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  HttpCode(200)(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnionAccounts'))(prototype, 'list', list);

  const start = descriptor('start');
  Req()(prototype, 'start', 0);
  Param('union_account_id')(prototype, 'start', 1);
  Body()(prototype, 'start', 2);
  Post(':union_account_id/reauthorize')(prototype, 'start', start);
  HttpCode(200)(prototype, 'start', start);
  RouteSchema(contractRouteSchema('adminStartUnionReauthorization'))(prototype, 'start', start);

  const result = descriptor('result');
  Req()(prototype, 'result', 0);
  Param('union_account_id')(prototype, 'result', 1);
  Param('session_id')(prototype, 'result', 2);
  Get(':union_account_id/reauthorize/:session_id')(prototype, 'result', result);
  HttpCode(200)(prototype, 'result', result);
  RouteSchema(contractRouteSchema('adminGetUnionReauthorization'))(prototype, 'result', result);

  const callback = descriptor('callback');
  Req()(prototype, 'callback', 0);
  Body()(prototype, 'callback', 1);
  Post('oauth/callback')(prototype, 'callback', callback);
  HttpCode(200)(prototype, 'callback', callback);
  RouteSchema(callbackRouteSchema())(prototype, 'callback', callback);

  const put = descriptor('putCredential');
  Req()(prototype, 'putCredential', 0);
  Param('union_account_id')(prototype, 'putCredential', 1);
  Body()(prototype, 'putCredential', 2);
  Put(':union_account_id/credential')(prototype, 'putCredential', put);
  HttpCode(200)(prototype, 'putCredential', put);
  RouteSchema(contractRouteSchema('adminPutUnionCredential'))(prototype, 'putCredential', put);

  Controller('admin/v1/union-accounts')(AdminUnionAccountsController);
}
