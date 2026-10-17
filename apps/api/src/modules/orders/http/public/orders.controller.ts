// B1-08l: GET /v1/orders (listOrders) and GET /v1/orders/{order_id} (getOrder): x-auth login,
// unsigned, not idempotent. A thin wrapper over the shared OrderQueries: the subject is the
// request's token principal only (app_id, uid → user_id), never X-App-Id, X-User-Id or a query
// parameter (BR-AI-03); the query string is already checked by contractRouteSchema. A cursor the
// queries cannot read is 20001 with data.fields; a detail that is missing, someone else's, another
// app's, unattributed or outside the visible range is the same 404 / 30701. Logs carry flat fields
// only (app_id, scope, outcome, count): never q, a title or an order number.
//
// Nest's decorators are applied as plain calls (erasable syntax, as in the notification module).
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpException, Inject, Param, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  ROOT_LOGGER,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type RootLogger,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import {
  OrderQueries,
  OrderQueryError,
  type OrderFilter,
  type OrderSubject,
} from '../../application/order-queries.ts';

/** What the handlers read of the Fastify request, already checked by the request checks. */
export interface OrdersHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly query?: Partial<OrderFilter>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILTER_KEYS = [
  'status_group',
  'display_status',
  'platform',
  'q',
  'paid_month',
  'cursor',
  'limit',
] as const;

export class OrdersController {
  readonly #queries: OrderQueries;
  readonly #logger: RootLogger;

  constructor(queries: OrderQueries, logger: RootLogger) {
    this.#queries = queries;
    this.#logger = logger.child({ module: 'orders' });
  }

  async list(request: OrdersHttpRequest): Promise<Schema<'OrderListResponse'>> {
    const subject = this.#subject(request);
    const query = request.query ?? {};
    const filter: OrderFilter = { scope: query.scope as OrderFilter['scope'] };
    for (const key of FILTER_KEYS) {
      if (query[key] !== undefined) Object.assign(filter, { [key]: query[key] });
    }
    try {
      const data = await this.#queries.list(subject, filter);
      this.#logger.info(
        {
          app_id: subject.app_id,
          scope: filter.scope,
          outcome: 'ok',
          count: data.items.length,
        },
        'orders.list',
      );
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof OrderQueryError) {
        this.#logger.info(
          { app_id: subject.app_id, scope: filter.scope, outcome: 'invalid' },
          'orders.list',
        );
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }

  async get(request: OrdersHttpRequest, orderId: string): Promise<Schema<'OrderDetailResponse'>> {
    const subject = this.#subject(request);
    // The contract's Id is any short string; an order id is always a UUID, so anything else is a
    // parameter error before the queries are asked (编排者口径 2).
    if (!UUID.test(orderId)) {
      const refused = fieldsErrorEnvelope(['order_id'], request.id);
      throw new HttpException(refused.body, refused.statusCode);
    }
    const data = await this.#queries.get(subject, orderId);
    this.#logger.info(
      { app_id: subject.app_id, outcome: data === null ? 'not_found' : 'ok' },
      'orders.get',
    );
    if (data === null) {
      throw new HttpException({ code: 30701, msg: '订单不存在', trace_id: request.id }, 404);
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  #subject(request: OrdersHttpRequest): OrderSubject {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { app_id: principal.app_id, user_id: principal.uid };
  }
}

{
  const prototype = OrdersController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const get = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Inject(OrderQueries)(OrdersController, undefined, 0);
  Inject(ROOT_LOGGER)(OrdersController, undefined, 1);
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listOrders'))(prototype, 'list', list);
  Req()(prototype, 'get', 0);
  Param('order_id')(prototype, 'get', 1);
  Get(':order_id')(prototype, 'get', get);
  RouteSchema(contractRouteSchema('getOrder'))(prototype, 'get', get);
  Controller('v1/orders')(OrdersController);
}
