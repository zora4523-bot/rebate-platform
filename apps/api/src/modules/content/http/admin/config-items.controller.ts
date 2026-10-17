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
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminOperationInput,
  type CheckedRequest,
  type ContractOperationId,
} from '../../../platform/index.ts';
import {
  ConfigItemAdmin,
  ConfigItemConflictError,
  ConfigItemFieldsError,
  configBatchPermission,
  requireConfigItem,
  type ConfigItemActor,
  type ConfigPageQuery,
} from '../../application/config-item-admin.ts';

interface ConfigItemRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

const READ_ACCESS = {
  permission: ['config.general', 'config.risk', 'config.business'],
  readOnly: true,
} as const;
type Access = Pick<AdminOperationInput, 'permission' | 'readOnly'>;

/** Mounted on the admin entry only; guard identities are the sole source of app and author. */
export class AdminConfigItemsController {
  readonly #guard: AdminOperationGuard;
  readonly #items: ConfigItemAdmin;

  constructor(guard: AdminOperationGuard, items: ConfigItemAdmin) {
    this.#guard = guard;
    this.#items = items;
  }

  list(
    request: ConfigItemRequest,
    query: ConfigPageQuery,
  ): Promise<Schema<'AdminConfigItemPageResponse'>> {
    return this.#run(
      request,
      () => READ_ACCESS,
      (actor) => this.#items.list(actor.appId, query ?? {}),
    );
  }

  get(request: ConfigItemRequest, key: string): Promise<Schema<'AdminConfigItemResponse'>> {
    return this.#run(
      request,
      () => READ_ACCESS,
      (actor) => this.#items.get(actor.appId, key),
    );
  }

  versions(
    request: ConfigItemRequest,
    key: string,
    query: ConfigPageQuery,
  ): Promise<Schema<'AdminConfigItemVersionPageResponse'>> {
    return this.#run(
      request,
      () => READ_ACCESS,
      (actor) => this.#items.versions(actor.appId, key, query ?? {}),
    );
  }

  update(
    request: ConfigItemRequest,
    key: string,
    body: Schema<'AdminConfigItemUpdateRequest'>,
  ): Promise<Schema<'AdminConfigItemResponse'>> {
    return this.#run(
      request,
      () => ({ permission: requireConfigItem(key, true).permission }),
      (actor) => this.#items.update(actor, key, body),
    );
  }

  batch(
    request: ConfigItemRequest,
    body: Schema<'AdminConfigItemBatchRequest'>,
  ): Promise<Schema<'AdminConfigItemListResponse'>> {
    return this.#run(
      request,
      () => ({ permission: configBatchPermission(body.items) }),
      (actor) => this.#items.batch(actor, body),
    );
  }

  rollback(
    request: ConfigItemRequest,
    key: string,
    body: Schema<'AdminConfigItemRollbackRequest'>,
  ): Promise<Schema<'AdminConfigItemResponse'>> {
    return this.#run(
      request,
      () => ({ permission: requireConfigItem(key, true).permission }),
      (actor) => this.#items.rollback(actor, key, body),
    );
  }

  async #run<T>(
    request: ConfigItemRequest,
    access: () => Access,
    work: (actor: ConfigItemActor) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    try {
      await this.#guard.run({ request, ...access() }, async (actor) => {
        const data = await work({
          appId: actor.appId,
          adminId: actor.adminId,
          loginName: actor.loginName,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          traceId: request.id,
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      });
    } catch (error) {
      // Rejections throw through the guard, so a failed operation never consumes step-up.
      if (error instanceof ConfigItemFieldsError) {
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      if (error instanceof ConfigItemConflictError) {
        throw new HttpException(
          {
            code: 20902,
            msg: '状态已变化，请刷新后重试',
            data: { resource: 'config_item' },
            trace_id: request.id,
          },
          409,
        );
      }
      throw error;
    }
    if (response === undefined) throw new Error('content: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls also compile in the test project's erasable-syntax mode.
{
  const prototype = AdminConfigItemsController.prototype;
  Inject(AdminOperationGuard)(AdminConfigItemsController, undefined, 0);
  Inject(ConfigItemAdmin)(AdminConfigItemsController, undefined, 1);
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Req()(prototype, 'get', 0);
  Param('key')(prototype, 'get', 1);
  Req()(prototype, 'versions', 0);
  Param('key')(prototype, 'versions', 1);
  Query()(prototype, 'versions', 2);
  Req()(prototype, 'update', 0);
  Param('key')(prototype, 'update', 1);
  Body()(prototype, 'update', 2);
  Req()(prototype, 'batch', 0);
  Body()(prototype, 'batch', 1);
  Req()(prototype, 'rollback', 0);
  Param('key')(prototype, 'rollback', 1);
  Body()(prototype, 'rollback', 2);

  const routes = [
    ['list', Get(), 'adminListConfigItems'],
    ['get', Get(':key'), 'adminGetConfigItem'],
    ['versions', Get(':key/versions'), 'adminListConfigItemVersions'],
    ['update', Put(':key'), 'adminUpdateConfigItem'],
    ['batch', Post('batch'), 'adminBatchUpdateConfigItems'],
    ['rollback', Post(':key/rollback'), 'adminRollbackConfigItem'],
  ] as const;
  for (const [method, route, operation] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    route(prototype, method, descriptor);
    HttpCode(200)(prototype, method, descriptor);
    // F1-10e ruling 17: the orchestrator removes planned and regenerates schemas in its
    // mechanical commit. Missing generated schemas fail closed until that step is done.
    RouteSchema(contractRouteSchema(operation as ContractOperationId))(
      prototype,
      method,
      descriptor,
    );
  }
  Controller('admin/v1/config-items')(AdminConfigItemsController);
}
