// B2-15f: GET /admin/v1/pay-orders, GET /admin/v1/pay-orders/{pay_order_id}, POST
// /admin/v1/pay-orders/{pay_order_id}/resolve and GET /admin/v1/pay-anomalies (listAdminPayOrders,
// getAdminPayOrder, resolveAdminPayOrder, listAdminPayAnomalies; 08 BR-PAY-05 ③④, BR-PAY-08 ④;
// 04 §11.2). Only authorisation, the parameters and the call into application/ live here.
//
// Mounted only by PaymentModule.forAdmin on the admin entry. The admin request check has verified
// the admin_token and the route schema the query, the path and the body before this runs. The
// AdminOperationGuard re-reads the account and checks the permission point: the three reads hold
// pay.view, read only (no step-up; an X-Step-Up-Token header is neither read nor consumed); the
// resolve holds pay.resolve with its step-up tier totp (specs/permissions.yaml), the token consumed
// only after an answer with code 0. A super admin holds every point. Refusals of the use cases
// (20001 data.fields, 20902 resource pay_order) are thrown as error envelopes for the global
// filter. Answers are no-store; reading writes no audit record.
// Without the database or the queue (isolated HTTP unit tests) the routes still register and every
// call fails closed (50001).
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
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
  PayAdminFieldsError,
  PayAdminReads,
  type PayAnomalyListQuery,
  type PayOrderListQuery,
} from '../../application/pay-admin-reads.ts';
import { resolvePayOrder, type PayResolveDeps } from '../../application/pay-resolve.ts';

/** Nest token of the resolve's dependencies (null in a process without database or queue). */
export const PAY_RESOLVE_DEPS = Symbol('PAYMENT_PAY_RESOLVE_DEPS');

/** specs/permissions.yaml: pay.view (step-up null), pay.resolve (step-up totp). */
const VIEW = 'pay.view';
const RESOLVE = 'pay.resolve';

/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';

export interface AdminPayOrdersRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException(refused.body, refused.statusCode);
}

export class AdminPayOrdersController {
  readonly #guard: AdminOperationGuard;
  readonly #reads: PayAdminReads;
  readonly #resolve: PayResolveDeps | null;

  constructor(guard: AdminOperationGuard, reads: PayAdminReads, resolve: PayResolveDeps | null) {
    this.#guard = guard;
    this.#reads = reads;
    this.#resolve = resolve;
  }

  list(
    request: AdminPayOrdersRequest,
    query: PayOrderListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayOrderPageResponse'>> {
    return this.#read(request, reply, (appId) => this.#reads.listOrders(appId, query));
  }

  detail(
    request: AdminPayOrdersRequest,
    payOrderId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayOrderDetailResponse'>> {
    return this.#read(request, reply, (appId) => this.#reads.detail(appId, payOrderId));
  }

  anomalies(
    request: AdminPayOrdersRequest,
    query: PayAnomalyListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayAnomalyPageResponse'>> {
    return this.#read(request, reply, (appId) => this.#reads.listAnomalies(appId, query));
  }

  // The body is fixed by the route schema (expected_status PENDING, action query_and_settle) and
  // nothing in it is read: the server queries the channel itself.
  async resolve(
    request: AdminPayOrdersRequest,
    payOrderId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayOrderResolveResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<Schema<'AdminPayOrderResolveResult'>> | undefined;
    await this.#guard.run({ request, permission: RESOLVE }, async (actor) => {
      const deps = this.#resolve;
      if (deps === null) throw new Error('payment: the resolve needs the database and the queue');
      const outcome = await resolvePayOrder(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        payOrderId,
      );
      switch (outcome.kind) {
        case 'fields':
          throw fieldsRefusal(outcome.fields, request.id);
        case 'conflict':
          throw new HttpException(
            {
              code: 20902,
              msg: CONFLICT_MESSAGE,
              data: { resource: 'pay_order' },
              trace_id: request.id,
            },
            409,
          );
        case 'resolved':
          response = { code: 0, msg: '', data: outcome.result, trace_id: request.id };
          return { statusCode: 200, body: response };
      }
    });
    if (response === undefined) throw new Error('payment: admin guard returned without an answer');
    return response;
  }

  async #read<T>(
    request: AdminPayOrdersRequest,
    reply: HeaderReply,
    read: (appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: VIEW, readOnly: true }, async (actor) => {
      try {
        response = { code: 0, msg: '', data: await read(actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof PayAdminFieldsError) throw fieldsRefusal(error.fields, request.id);
        throw error;
      }
    });
    if (response === undefined) throw new Error('payment: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminPayOrdersController.prototype;
  Inject(AdminOperationGuard)(AdminPayOrdersController, undefined, 0);
  Inject(PayAdminReads)(AdminPayOrdersController, undefined, 1);
  Inject(PAY_RESOLVE_DEPS)(AdminPayOrdersController, undefined, 2);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('pay-orders')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminPayOrders'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('pay_order_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('pay-orders/:pay_order_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminPayOrder'))(prototype, 'detail', detail);

  const resolve = Object.getOwnPropertyDescriptor(prototype, 'resolve')!;
  Req()(prototype, 'resolve', 0);
  Param('pay_order_id')(prototype, 'resolve', 1);
  Res({ passthrough: true })(prototype, 'resolve', 2);
  Post('pay-orders/:pay_order_id/resolve')(prototype, 'resolve', resolve);
  HttpCode(200)(prototype, 'resolve', resolve);
  RouteSchema(contractRouteSchema('resolveAdminPayOrder'))(prototype, 'resolve', resolve);

  const anomalies = Object.getOwnPropertyDescriptor(prototype, 'anomalies')!;
  Req()(prototype, 'anomalies', 0);
  Query()(prototype, 'anomalies', 1);
  Res({ passthrough: true })(prototype, 'anomalies', 2);
  Get('pay-anomalies')(prototype, 'anomalies', anomalies);
  RouteSchema(contractRouteSchema('listAdminPayAnomalies'))(prototype, 'anomalies', anomalies);

  Controller('admin/v1')(AdminPayOrdersController);
}
