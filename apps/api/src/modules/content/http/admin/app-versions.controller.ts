// /admin/v1/app-versions* (F1-02zc; contract adminListAppVersions, adminGetAppVersion,
// adminSaveAppVersion). 04 §11.2 content.app_version: the two reads pass `readOnly: true` (no
// step-up, X-Step-Up-Token neither read nor consumed). A save needs the totp tier only when it
// raises min_supported_version (operation content.app_version.raise_min_supported_version): the
// tier is chosen from an unlocked primary read of the current row made before the guard runs
// (Y1), and the save transaction rejects with 20902 when the locked row is no longer that row.
// The route schema has checked the path and body (20001) before a handler runs; refusals are thrown
// through the guard, so a failed save never consumes the step-up token. The app and admin are the
// guard's actor, never request fields. Served by the admin entry only (ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// agreements.controller.ts.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AppVersionAdmin,
  AppVersionConflictError,
  AppVersionFieldsError,
  AppVersionNotFoundError,
  RAISE_MIN_SUPPORTED_OPERATION,
  needsRaiseStepUp,
  type EditablePlatform,
} from '../../application/app-version-admin.ts';

export interface AppVersionAdminRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const PERMISSION = 'content.app_version';

type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

export class AdminAppVersionsController {
  readonly #guard: AdminOperationGuard;
  readonly #versions: AppVersionAdmin;

  constructor(guard: AdminOperationGuard, versions: AppVersionAdmin) {
    this.#guard = guard;
    this.#versions = versions;
  }

  /** adminListAppVersions. */
  list(request: AppVersionAdminRequest): Promise<Schema<'AdminAppVersionListResponse'>> {
    return this.#run(request, { permission: PERMISSION, readOnly: true }, (actor) =>
      this.#versions.list(actor.appId),
    );
  }

  /** adminGetAppVersion. */
  detail(
    request: AppVersionAdminRequest,
    platform: string,
    channel: string,
  ): Promise<Schema<'AdminAppVersionResponse'>> {
    return this.#run(request, { permission: PERMISSION, readOnly: true }, (actor) =>
      this.#versions.get(actor.appId, platform, channel),
    );
  }

  /** adminSaveAppVersion. */
  async save(
    request: AppVersionAdminRequest,
    platform: EditablePlatform,
    channel: string,
    body: Schema<'AdminAppVersionSaveRequest'>,
  ): Promise<Schema<'AdminAppVersionResponse'>> {
    const principal = adminPrincipal(request);
    if (principal === undefined) {
      // Not x-auth admin: let the guard answer as it does for any such route (50001).
      return this.#run(request, { permission: PERMISSION }, () =>
        Promise.reject(new Error('content: app version save without an admin principal')),
      );
    }
    // Y1: the tier follows the row as stored now, never the request's expected_row_version.
    const pre = await this.#versions.preRead(principal.appId, platform, channel);
    const raise = needsRaiseStepUp(pre, body);
    return this.#run(
      request,
      raise
        ? { permission: PERMISSION, operation: RAISE_MIN_SUPPORTED_OPERATION }
        : { permission: PERMISSION },
      (actor) =>
        this.#versions.save(
          {
            appId: actor.appId,
            adminId: actor.adminId,
            ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          },
          platform,
          channel,
          body,
          pre,
        ),
    );
  }

  async #run<T>(
    request: AppVersionAdminRequest,
    access: { permission: string; operation?: string; readOnly?: true },
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, ...access }, async (actor) => {
      try {
        const data = await work(actor);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        // Thrown through the guard: a refused save releases, never consumes, the step-up token.
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('content: admin guard returned without the call');
    return response;
  }
}

/** 20001 (data.fields), 20902 (data.resource=app_version), 30701; anything else rethrown (50001). */
export function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AppVersionFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AppVersionConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'app_version' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AppVersionNotFoundError) {
    return new HttpException({ code: 30701, msg: '内容不存在', trace_id: traceId }, 404);
  }
  return error;
}

{
  const prototype = AdminAppVersionsController.prototype;
  const routes = [
    ['list', 'Get', '', 'adminListAppVersions', []],
    ['detail', 'Get', ':platform/:channel', 'adminGetAppVersion', ['platform', 'channel']],
    ['save', 'Put', ':platform/:channel', 'adminSaveAppVersion', ['platform', 'channel', 'body']],
  ] as const;
  Inject(AdminOperationGuard)(AdminAppVersionsController, undefined, 0);
  Inject(AppVersionAdmin)(AdminAppVersionsController, undefined, 1);
  for (const [name, method, path, operationId, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    (args as readonly string[]).forEach((arg, index) => {
      if (arg === 'body') Body()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    (method === 'Get' ? Get(path) : Put(path))(prototype, name, descriptor);
    HttpCode(200)(prototype, name, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, descriptor);
  }
  Controller('admin/v1/app-versions')(AdminAppVersionsController);
}
