// /admin/v1/platform-icons reads (F1-06w; contract adminListPlatformIcons,
// adminListPlatformIconVersions) and writes (F1-06y; adminUpdatePlatformIconVersion,
// adminPublishPlatformIcon, adminRestoreBuiltinPlatformIcon: CAS, no Idempotency-Key); 04 §11.2
// content.platform_icon, no step-up. The admin request
// check has verified the admin_token, and the contract's route schema has validated key, page,
// page_size and the write bodies (20001) before a handler runs. Each handler runs inside platform's
// AdminOperationGuard for content.platform_icon (10403 without the point), so no icon table is
// queried before the permission passes; the app is the guard's actor, never a request field.
// Served by the admin entry only (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
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
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  PlatformIconFieldsError,
  PlatformIconReader,
  type PlatformIconPageQuery,
} from '../../application/platform-icon-reader.ts';
import {
  PlatformIconConflictError,
  PlatformIconWriter,
  type PlatformIconActor,
  type PlatformIconPublishBody,
  type PlatformIconRestoreBody,
  type PlatformIconSourceBody,
} from '../../application/platform-icon-writer.ts';

export interface PlatformIconsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const PERMISSION = 'content.platform_icon';

export class AdminPlatformIconsController {
  readonly #guard: AdminOperationGuard;
  readonly #reader: PlatformIconReader;
  readonly #writer: PlatformIconWriter;

  constructor(guard: AdminOperationGuard, reader: PlatformIconReader, writer: PlatformIconWriter) {
    this.#guard = guard;
    this.#reader = reader;
    this.#writer = writer;
  }

  /** adminListPlatformIcons: every mark of the admin's app, in enum order. */
  async list(request: PlatformIconsRequest): Promise<Schema<'AdminPlatformIconListResponse'>> {
    let response: Schema<'AdminPlatformIconListResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const data = await this.#reader.list(actor.appId);
      response = { code: 0, msg: '', data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    return answered(response);
  }

  /** adminListPlatformIconVersions: one page of a mark's saved versions, newest first. */
  async versions(
    request: PlatformIconsRequest,
    key: string,
    query: PlatformIconPageQuery,
  ): Promise<Schema<'AdminPlatformIconVersionPageResponse'>> {
    let response: Schema<'AdminPlatformIconVersionPageResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#reader.versions(actor.appId, key, query ?? {});
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminUpdatePlatformIconVersion: register source_url / downloaded_on of a draft version. */
  async register(
    request: PlatformIconsRequest,
    key: string,
    version: string,
    body: PlatformIconSourceBody,
  ): Promise<Schema<'AdminPlatformIconVersionResponse'>> {
    let response: Schema<'AdminPlatformIconVersionResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#writer.register(editorOf(actor, request), key, version, body);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminPublishPlatformIcon: publish or roll back. */
  async publish(
    request: PlatformIconsRequest,
    key: string,
    body: PlatformIconPublishBody,
  ): Promise<Schema<'AdminPlatformIconResponse'>> {
    let response: Schema<'AdminPlatformIconResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#writer.publish(editorOf(actor, request), key, body);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }

  /** adminRestoreBuiltinPlatformIcon: back to the built-in image. */
  async restore(
    request: PlatformIconsRequest,
    key: string,
    body: PlatformIconRestoreBody,
  ): Promise<Schema<'AdminPlatformIconResponse'>> {
    let response: Schema<'AdminPlatformIconResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#writer.restore(editorOf(actor, request), key, body);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }
}

/** The guard's verified actor; the request contributes only its address for the audit row. */
function editorOf(
  actor: { readonly appId: string; readonly adminId: string; readonly loginName: string },
  request: PlatformIconsRequest,
): PlatformIconActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    loginName: actor.loginName,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** 20001 (data.fields) and 20902 (data.resource=platform_icon); anything else is rethrown. */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof PlatformIconFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof PlatformIconConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'platform_icon' },
        trace_id: traceId,
      },
      409,
    );
  }
  return error;
}

/** The guard returns only after business ran; anything else is a programming error (50001). */
function answered<T>(response: T | undefined): T {
  if (response === undefined) throw new Error('content: admin guard returned without the read');
  return response;
}

{
  const prototype = AdminPlatformIconsController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const versions = Object.getOwnPropertyDescriptor(prototype, 'versions')!;
  const register = Object.getOwnPropertyDescriptor(prototype, 'register')!;
  const publish = Object.getOwnPropertyDescriptor(prototype, 'publish')!;
  const restore = Object.getOwnPropertyDescriptor(prototype, 'restore')!;
  Inject(AdminOperationGuard)(AdminPlatformIconsController, undefined, 0);
  Inject(PlatformIconReader)(AdminPlatformIconsController, undefined, 1);
  Inject(PlatformIconWriter)(AdminPlatformIconsController, undefined, 2);
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListPlatformIcons'))(prototype, 'list', list);
  Req()(prototype, 'versions', 0);
  Param('key')(prototype, 'versions', 1);
  Query()(prototype, 'versions', 2);
  Get(':key/versions')(prototype, 'versions', versions);
  RouteSchema(contractRouteSchema('adminListPlatformIconVersions'))(
    prototype,
    'versions',
    versions,
  );
  Req()(prototype, 'register', 0);
  Param('key')(prototype, 'register', 1);
  Param('version')(prototype, 'register', 2);
  Body()(prototype, 'register', 3);
  Patch(':key/versions/:version')(prototype, 'register', register);
  RouteSchema(contractRouteSchema('adminUpdatePlatformIconVersion'))(
    prototype,
    'register',
    register,
  );
  Req()(prototype, 'publish', 0);
  Param('key')(prototype, 'publish', 1);
  Body()(prototype, 'publish', 2);
  Post(':key/publish')(prototype, 'publish', publish);
  HttpCode(200)(prototype, 'publish', publish);
  RouteSchema(contractRouteSchema('adminPublishPlatformIcon'))(prototype, 'publish', publish);
  Req()(prototype, 'restore', 0);
  Param('key')(prototype, 'restore', 1);
  Body()(prototype, 'restore', 2);
  Post(':key/restore-builtin')(prototype, 'restore', restore);
  HttpCode(200)(prototype, 'restore', restore);
  RouteSchema(contractRouteSchema('adminRestoreBuiltinPlatformIcon'))(
    prototype,
    'restore',
    restore,
  );
  Controller('admin/v1/platform-icons')(AdminPlatformIconsController);
}
