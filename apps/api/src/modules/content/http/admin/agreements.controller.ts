// /admin/v1/agreements* (F1-02p; contract adminListAgreements, adminGetAgreementVersion,
// adminPublishAgreementVersion). 04 §11.2 content.agreement: the two reads pass `readOnly: true`
// (no step-up, X-Step-Up-Token neither read nor consumed); publishing needs the point's totp tier,
// which the guard checks and consumes only after a successful publish. The contract's route schema
// has validated type, version, page, page_size and the body (20001) before a handler runs; each
// handler runs inside platform's AdminOperationGuard, so no agreement table is queried before the
// permission passes; the app and admin are the guard's actor, never request fields. Served by the
// admin entry only (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// pages.controller.ts.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
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
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AgreementAdmin,
  AgreementConflictError,
  AgreementFieldsError,
  AgreementNotFoundError,
  type AgreementActor,
  type AgreementListQuery,
} from '../../application/agreement-admin.ts';

export interface AgreementAdminRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

export type { AgreementListQuery };

const PERMISSION = 'content.agreement';

export class AdminAgreementsController {
  readonly #guard: AdminOperationGuard;
  readonly #agreements: AgreementAdmin;

  constructor(guard: AdminOperationGuard, agreements: AgreementAdmin) {
    this.#guard = guard;
    this.#agreements = agreements;
  }

  /** adminListAgreements. */
  list(
    request: AgreementAdminRequest,
    query: AgreementListQuery,
  ): Promise<Schema<'AdminAgreementVersionListResponse'>> {
    return this.#run(request, true, (actor) => this.#agreements.list(actor.appId, query ?? {}));
  }

  /** adminGetAgreementVersion. */
  detail(
    request: AgreementAdminRequest,
    type: Schema<'AgreementType'>,
    version: number,
  ): Promise<Schema<'AdminAgreementVersionDetailResponse'>> {
    return this.#run(request, true, (actor) =>
      this.#agreements.detail(actor.appId, type, Number(version)),
    );
  }

  /** adminPublishAgreementVersion. */
  publish(
    request: AgreementAdminRequest,
    type: Schema<'AgreementType'>,
    body: Schema<'AdminAgreementPublishRequest'>,
  ): Promise<Schema<'AdminAgreementVersionResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#agreements.publish(publisherOf(actor, request), type, body),
    );
  }

  async #run<T>(
    request: AgreementAdminRequest,
    readOnly: boolean,
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    await this.#guard.run(
      readOnly
        ? { request, permission: PERMISSION, readOnly: true }
        : { request, permission: PERMISSION },
      async (actor) => {
        try {
          const data = await work(actor);
          response = { code: 0, msg: '', data, trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          throw refusal(error, request.id);
        }
      },
    );
    if (response === undefined) throw new Error('content: admin guard returned without the call');
    return response;
  }
}

/** The guard's verified actor; the request contributes only its address for the audit row. */
function publisherOf(actor: AdminActor, request: AgreementAdminRequest): AgreementActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    loginName: actor.loginName,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** 20001 (data.fields), 20902 (data.resource=agreement), 30701; anything else rethrown (50001). */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AgreementFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AgreementConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'agreement' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AgreementNotFoundError) {
    return new HttpException({ code: 30701, msg: '内容不存在', trace_id: traceId }, 404);
  }
  return error;
}

{
  const prototype = AdminAgreementsController.prototype;
  const routes = [
    ['list', 'Get', '', 'adminListAgreements', ['query']],
    ['detail', 'Get', ':type/versions/:version', 'adminGetAgreementVersion', ['type', 'version']],
    ['publish', 'Post', ':type/versions', 'adminPublishAgreementVersion', ['type', 'body']],
  ] as const;
  Inject(AdminOperationGuard)(AdminAgreementsController, undefined, 0);
  Inject(AgreementAdmin)(AdminAgreementsController, undefined, 1);
  for (const [name, method, path, operationId, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    args.forEach((arg, index) => {
      if (arg === 'query') Query()(prototype, name, index + 1);
      else if (arg === 'body') Body()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    (method === 'Get' ? Get(path) : Post(path))(prototype, name, descriptor);
    if (method === 'Post') HttpCode(200)(prototype, name, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, descriptor);
  }
  Controller('admin/v1/agreements')(AdminAgreementsController);
}
