// B1-10i: GET /admin/v1/orders (adminListOrders) and GET /admin/v1/orders/{order_id}
// (adminGetOrder), the console's order list and detail (04 §11.2). Mounted only by
// OrdersAdminModule on the admin entry. The admin request check has verified the admin_token and
// the route schema the query before this runs. Permission through platform's
// AdminOperationGuard, read only (no step-up, an X-Step-Up-Token header is ignored): `order.view`
// reads every order of the app; with `user_id` an account holding `user.lookup` may read that
// user's orders too (['order.view', 'user.lookup'], any of them); without `user_id` only
// `order.view` (else 10403). The answer is no-store; reading writes no audit record.
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminOrders,
  AdminOrdersFieldsError,
  type AdminOrderListQuery,
} from '../../application/admin-orders.ts';

interface OrdersRequest extends CheckedRequest {
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface DetailQuery {
  readonly user_id?: string;
}

/** user.lookup only together with user_id (contract adminListOrders / adminGetOrder). */
function permissionOf(userId: string | undefined): string | readonly string[] {
  return userId === undefined ? 'order.view' : ['order.view', 'user.lookup'];
}

export class AdminOrdersController {
  readonly #guard: AdminOperationGuard;
  readonly #orders: AdminOrders;

  constructor(guard: AdminOperationGuard, orders: AdminOrders) {
    this.#guard = guard;
    this.#orders = orders;
  }

  list(
    request: OrdersRequest,
    query: AdminOrderListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminOrderPageResponse'>> {
    return this.run(request, reply, query.user_id, (appId) => this.#orders.list(appId, query));
  }

  detail(
    request: OrdersRequest,
    orderId: string,
    query: DetailQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminOrderDetailResponse'>> {
    return this.run(request, reply, query.user_id, (appId) =>
      this.#orders.detail(appId, orderId, query.user_id),
    );
  }

  private async run<T>(
    request: OrdersRequest,
    reply: HeaderReply,
    userId: string | undefined,
    read: (appId: string) => Promise<T>,
  ): Promise<{ code: 0; msg: string; data: T; trace_id: string }> {
    reply.header('Cache-Control', 'no-store');
    let response: { code: 0; msg: string; data: T; trace_id: string } | undefined;
    await this.#guard.run(
      { request, permission: permissionOf(userId), readOnly: true },
      async (actor) => {
        try {
          response = { code: 0, msg: '', data: await read(actor.appId), trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          if (!(error instanceof AdminOrdersFieldsError)) throw error;
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
      },
    );
    if (response === undefined) throw new Error('orders: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as identity's and risk's admin controllers (no parameter decorators).
{
  const prototype = AdminOrdersController.prototype;
  Inject(AdminOperationGuard)(AdminOrdersController, undefined, 0);
  Inject(AdminOrders)(AdminOrdersController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListOrders'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('order_id')(prototype, 'detail', 1);
  Query()(prototype, 'detail', 2);
  Res({ passthrough: true })(prototype, 'detail', 3);
  Get(':order_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetOrder'))(prototype, 'detail', detail);
  Controller('admin/v1/orders')(AdminOrdersController);
}
