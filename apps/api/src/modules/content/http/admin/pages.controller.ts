// /admin/v1/pages* (F1-09f; contract adminListPageConfigs, adminGetPageConfig,
// adminListPageConfigVersions, adminGetPageConfigVersion, adminCreatePageConfigVersion,
// adminPublishPageConfig, adminUpdatePageConfigGray, adminRollbackPageConfig; F1-09p
// adminCancelPageConfigSchedule). 04 §11.2
// content.page, no step-up: the four reads pass `readOnly: true`. The contract's route schema has
// validated page_key, version, page, page_size and the bodies (20001) before a handler runs; each
// handler runs inside platform's AdminOperationGuard, so no page table is queried before the
// permission passes; the app is the guard's actor, never a request field. Served by the admin
// entry only (content's ContentAdminModule). The preview token route (adminCreatePagePreviewToken)
// belongs to F1-09e and is not mounted here.
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// platform-icons.controller.ts.
import {
  Body,
  Controller,
  Delete,
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
  PageConfigAdmin,
  PageConflictError,
  PageFieldsError,
  PageNotFoundError,
  PageScheduleNotFoundError,
  type PageActor,
  type PageListQuery,
} from '../../application/page-config-admin.ts';

export interface PagesRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const PERMISSION = 'content.page';

export class AdminPagesController {
  readonly #guard: AdminOperationGuard;
  readonly #pages: PageConfigAdmin;

  constructor(guard: AdminOperationGuard, pages: PageConfigAdmin) {
    this.#guard = guard;
    this.#pages = pages;
  }

  /** adminListPageConfigs. */
  list(
    request: PagesRequest,
    query: PageListQuery,
  ): Promise<Schema<'AdminPageConfigListResponse'>> {
    return this.#run(request, true, (actor) => this.#pages.list(actor.appId, query ?? {}));
  }

  /** adminGetPageConfig. */
  detail(request: PagesRequest, key: string): Promise<Schema<'AdminPageConfigResponse'>> {
    return this.#run(request, true, (actor) => this.#pages.page(actor.appId, key));
  }

  /** adminListPageConfigVersions. */
  versions(
    request: PagesRequest,
    key: string,
    query: PageListQuery,
  ): Promise<Schema<'AdminPageConfigVersionListResponse'>> {
    return this.#run(request, true, (actor) => this.#pages.versions(actor.appId, key, query ?? {}));
  }

  /** adminGetPageConfigVersion. */
  version(
    request: PagesRequest,
    key: string,
    version: number,
  ): Promise<Schema<'AdminPageConfigVersionResponse'>> {
    return this.#run(request, true, (actor) =>
      this.#pages.version(actor.appId, key, Number(version)),
    );
  }

  /** adminCreatePageConfigVersion. */
  save(
    request: PagesRequest,
    key: string,
    body: Schema<'AdminPageConfigDraftRequest'>,
  ): Promise<Schema<'AdminPageConfigVersionResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#pages.save(editorOf(actor, request), key, body),
    );
  }

  /** adminPublishPageConfig. */
  publish(
    request: PagesRequest,
    key: string,
    body: Schema<'AdminPageConfigPublishRequest'>,
  ): Promise<Schema<'AdminPageConfigResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#pages.publish(editorOf(actor, request), key, body),
    );
  }

  /** adminUpdatePageConfigGray. */
  gray(
    request: PagesRequest,
    key: string,
    body: Schema<'AdminPageConfigGrayRequest'>,
  ): Promise<Schema<'AdminPageConfigResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#pages.gray(editorOf(actor, request), key, body),
    );
  }

  /** adminRollbackPageConfig. */
  rollback(
    request: PagesRequest,
    key: string,
    body: Schema<'AdminPageConfigRollbackRequest'>,
  ): Promise<Schema<'AdminPageConfigResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#pages.rollback(editorOf(actor, request), key, body),
    );
  }

  /** adminCancelPageConfigSchedule (F1-09p). */
  cancelSchedule(
    request: PagesRequest,
    key: string,
    query: { expected_revision: number },
  ): Promise<Schema<'AdminPageConfigResponse'>> {
    return this.#run(request, false, (actor) =>
      this.#pages.cancelSchedule(editorOf(actor, request), key, Number(query.expected_revision)),
    );
  }

  async #run<T>(
    request: PagesRequest,
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
function editorOf(actor: AdminActor, request: PagesRequest): PageActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** 20001 (data.fields only, P2), 20902 (data.resource=page), 30701; anything else rethrown. */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof PageFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof PageConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'page' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof PageScheduleNotFoundError) {
    return new HttpException({ code: 30701, msg: '定时发布不存在', trace_id: traceId }, 404);
  }
  if (error instanceof PageNotFoundError) {
    return new HttpException({ code: 30701, msg: '页面不存在', trace_id: traceId }, 404);
  }
  return error;
}

{
  const prototype = AdminPagesController.prototype;
  const routes = [
    ['list', 'Get', '', 'adminListPageConfigs', ['query']],
    ['detail', 'Get', ':page_key', 'adminGetPageConfig', ['page_key']],
    ['versions', 'Get', ':page_key/versions', 'adminListPageConfigVersions', ['page_key', 'query']],
    [
      'version',
      'Get',
      ':page_key/versions/:version',
      'adminGetPageConfigVersion',
      ['page_key', 'version'],
    ],
    ['save', 'Post', ':page_key/versions', 'adminCreatePageConfigVersion', ['page_key', 'body']],
    ['publish', 'Post', ':page_key/publish', 'adminPublishPageConfig', ['page_key', 'body']],
    ['gray', 'Post', ':page_key/gray', 'adminUpdatePageConfigGray', ['page_key', 'body']],
    ['rollback', 'Post', ':page_key/rollback', 'adminRollbackPageConfig', ['page_key', 'body']],
    [
      'cancelSchedule',
      'Delete',
      ':page_key/schedule',
      'adminCancelPageConfigSchedule',
      ['page_key', 'query'],
    ],
  ] as const;
  Inject(AdminOperationGuard)(AdminPagesController, undefined, 0);
  Inject(PageConfigAdmin)(AdminPagesController, undefined, 1);
  for (const [name, method, path, operationId, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    args.forEach((arg, index) => {
      if (arg === 'query') Query()(prototype, name, index + 1);
      else if (arg === 'body') Body()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    (method === 'Get' ? Get(path) : method === 'Delete' ? Delete(path) : Post(path))(
      prototype,
      name,
      descriptor,
    );
    if (method !== 'Get') HttpCode(200)(prototype, name, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, descriptor);
  }
  Controller('admin/v1/pages')(AdminPagesController);
}
