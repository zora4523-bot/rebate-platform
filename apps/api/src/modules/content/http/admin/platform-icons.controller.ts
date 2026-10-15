// /admin/v1/platform-icons reads (F1-06w; contract adminListPlatformIcons,
// adminListPlatformIconVersions; 04 §11.2 content.platform_icon, no step-up). The admin request
// check has verified the admin_token, and the contract's route schema has validated key, page and
// page_size (20001) before a handler runs. Each handler runs its read inside platform's
// AdminOperationGuard for content.platform_icon (10403 without the point), so no icon table is
// queried before the permission passes; the app is the guard's actor, never a request field.
// Served by the admin entry only (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
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

export interface PlatformIconsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

const PERMISSION = 'content.platform_icon';

export class AdminPlatformIconsController {
  readonly #guard: AdminOperationGuard;
  readonly #reader: PlatformIconReader;

  constructor(guard: AdminOperationGuard, reader: PlatformIconReader) {
    this.#guard = guard;
    this.#reader = reader;
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
        if (!(error instanceof PlatformIconFieldsError)) throw error;
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
    });
    return answered(response);
  }
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
  Inject(AdminOperationGuard)(AdminPlatformIconsController, undefined, 0);
  Inject(PlatformIconReader)(AdminPlatformIconsController, undefined, 1);
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
  Controller('admin/v1/platform-icons')(AdminPlatformIconsController);
}
