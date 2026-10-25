// B1-09i: POST / GET /admin/v1/order-syncs (adminCreateOrderSync, adminListOrderSyncs) and GET
// /admin/v1/order-syncs/limits (adminGetOrderSyncLimits), the console's manual order sync
// (01 F-ORD-10). Mounted only by OrdersAdminModule on the admin entry. The admin request check has
// verified the admin_token and the route schema the body / query before this runs. Permission
// `order.view` through platform's AdminOperationGuard (no step-up); app and requesting admin are
// the guard's actor, never the body or headers. The reads are no-store and write no audit record.
import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Query,
  Req,
  Res,
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
  ManualOrderSyncFieldsError,
  ManualOrderSyncPausedError,
  type ManualOrderSyncListQuery,
  type ManualOrderSyncs,
} from '../../application/manual-sync.ts';

/** The DI token of the console's manual sync use case. */
export const MANUAL_ORDER_SYNCS = Symbol('MANUAL_ORDER_SYNCS');

interface SyncRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

const PAUSED_MSG = '该平台的站长授权已暂停，暂不能手动同步';

export class AdminOrderSyncsController {
  readonly #guard: AdminOperationGuard;
  readonly #syncs: ManualOrderSyncs;

  constructor(guard: AdminOperationGuard, syncs: ManualOrderSyncs) {
    this.#guard = guard;
    this.#syncs = syncs;
  }

  create(
    request: SyncRequest,
    body: Schema<'AdminOrderSyncCreateRequest'>,
  ): Promise<Schema<'AdminOrderSyncCreateResponse'>> {
    return this.run(request, (actor) =>
      this.#syncs.create({ appId: actor.appId, adminId: actor.adminId }, body),
    );
  }

  list(
    request: SyncRequest,
    query: ManualOrderSyncListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminOrderSyncPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    return this.run(request, (actor) => this.#syncs.list(actor.appId, query));
  }

  limits(
    request: SyncRequest,
    reply: HeaderReply,
  ): Promise<Schema<'AdminOrderSyncLimitsResponse'>> {
    reply.header('Cache-Control', 'no-store');
    return this.run(request, async () => this.#syncs.limits());
  }

  private async run<T>(
    request: SyncRequest,
    work: (actor: { appId: string; adminId: string }) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    // No step-up on any of the three (contract): holding order.view is enough.
    await this.#guard.run({ request, permission: 'order.view', readOnly: true }, async (actor) => {
      try {
        response = { code: 0, msg: '', data: await work(actor), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        if (error instanceof ManualOrderSyncFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        if (error instanceof ManualOrderSyncPausedError) {
          throw new HttpException(
            {
              code: 30156,
              msg: PAUSED_MSG,
              data: { platform: error.platform },
              trace_id: request.id,
            },
            422,
          );
        }
        throw error;
      }
    });
    if (response === undefined) {
      throw new Error('orders: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminOrderSyncsController.prototype;
  Inject(AdminOperationGuard)(AdminOrderSyncsController, undefined, 0);
  Inject(MANUAL_ORDER_SYNCS)(AdminOrderSyncsController, undefined, 1);
  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Post('')(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateOrderSync'))(prototype, 'create', create);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListOrderSyncs'))(prototype, 'list', list);
  const limits = Object.getOwnPropertyDescriptor(prototype, 'limits')!;
  Req()(prototype, 'limits', 0);
  Res({ passthrough: true })(prototype, 'limits', 1);
  Get('limits')(prototype, 'limits', limits);
  RouteSchema(contractRouteSchema('adminGetOrderSyncLimits'))(prototype, 'limits', limits);
  Controller('admin/v1/order-syncs')(AdminOrderSyncsController);
}
