import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
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
  type CheckedRequest,
  type ContractOperationId,
} from '../../../platform/index.ts';
import {
  KillSwitchAdmin,
  KillSwitchConflictError,
  KillSwitchFieldsError,
} from '../../application/kill-switch-admin.ts';
import { killSwitchDescriptor } from '../../domain/kill-switch.ts';

interface KillSwitchRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

const READ_PERMISSIONS = ['switch.all', 'switch.payout', 'switch.pay'] as const;

/** Mounted only by ContentAdminModule; all identities come from the admin operation guard. */
export class AdminKillSwitchesController {
  readonly #guard: AdminOperationGuard;
  readonly #switches: KillSwitchAdmin;

  constructor(guard: AdminOperationGuard, switches: KillSwitchAdmin) {
    this.#guard = guard;
    this.#switches = switches;
  }

  async list(
    request: KillSwitchRequest,
    query: { readonly page?: number; readonly page_size?: number },
  ): Promise<Schema<'AdminKillSwitchPageResponse'>> {
    let response: Schema<'AdminKillSwitchPageResponse'> | undefined;
    await this.#guard.run(
      { request, permission: READ_PERMISSIONS, readOnly: true },
      async (actor) => {
        const data = await this.#switches.list(actor.appId, query ?? {});
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      },
    );
    return answered(response);
  }

  async update(
    request: KillSwitchRequest,
    key: string,
    body: Schema<'AdminKillSwitchUpdateRequest'>,
  ): Promise<Schema<'AdminKillSwitchResponse'>> {
    const descriptor = killSwitchDescriptor(key);
    if (descriptor === null || !descriptor.adminEditable) {
      throw refusal(new KillSwitchFieldsError(['key']), request.id);
    }
    let response: Schema<'AdminKillSwitchResponse'> | undefined;
    await this.#guard.run({ request, permission: descriptor.permissions }, async (actor) => {
      try {
        const data = await this.#switches.update(
          {
            appId: actor.appId,
            adminId: actor.adminId,
            loginName: actor.loginName,
            ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
            traceId: request.id,
          },
          key,
          body,
        );
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        // Throw on refusal so the guard never consumes a step-up token for a failed change.
        throw refusal(error, request.id);
      }
    });
    return answered(response);
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof KillSwitchFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof KillSwitchConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'kill_switch' },
        trace_id: traceId,
      },
      409,
    );
  }
  return error;
}

function answered<T>(response: T | undefined): T {
  if (response === undefined) throw new Error('content: admin guard returned without an answer');
  return response;
}

// Plain decorator calls keep this module compatible with the test project's erasable syntax.
{
  const prototype = AdminKillSwitchesController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const update = Object.getOwnPropertyDescriptor(prototype, 'update')!;
  Inject(AdminOperationGuard)(AdminKillSwitchesController, undefined, 0);
  Inject(KillSwitchAdmin)(AdminKillSwitchesController, undefined, 1);
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Get()(prototype, 'list', list);
  // F1-10d §9.2 #7: the orchestrator removes planned and regenerates route schemas in its
  // mechanical commit. Until then the id needs a type assertion; lookup still fails closed
  // at runtime if that mandatory generated schema has not been supplied.
  RouteSchema(contractRouteSchema('adminListKillSwitches' as ContractOperationId))(
    prototype,
    'list',
    list,
  );
  Req()(prototype, 'update', 0);
  Param('key')(prototype, 'update', 1);
  Body()(prototype, 'update', 2);
  Put(':key')(prototype, 'update', update);
  RouteSchema(contractRouteSchema('adminUpdateKillSwitch' as ContractOperationId))(
    prototype,
    'update',
    update,
  );
  Controller('admin/v1/kill-switches')(AdminKillSwitchesController);
}
