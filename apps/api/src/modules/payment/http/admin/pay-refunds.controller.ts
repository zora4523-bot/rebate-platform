// B2-15e: POST /admin/v1/pay-orders/{pay_order_id}/refunds and POST
// /admin/v1/pay-anomalies/{pay_anomaly_id}/refunds (createAdminPayRefund /
// createAdminPayAnomalyRefund; 08 BR-PAY-06; 04 §11.2 pay.refund). Only authorisation, the
// parameters and the call into application/pay-refunds.ts live here.
//
// Mounted only by PaymentModule.forAdmin on the admin entry. The admin request check has verified
// the admin_token and the route schema the body, the path and the Idempotency-Key header before
// this runs; the AdminOperationGuard re-reads the account and checks the permission point
// pay.refund (a super admin holds every point; step-up tier null: no X-Step-Up-Token is read,
// owner decision 2026-10-05). Inside the guard the use case runs under platform idempotency
// (subject a:<admin_users.id>) and returns the exact bytes to send — the stored first answer on a
// replay — so the reply is written raw here, as the api entry's createPayOrder does. Refusals of
// the guard are thrown as error envelopes for the global filter; the use case's own refusals
// (20001, 20902) come back as the idempotent response's body.
// Without the database, the queue or the idempotency primitive (isolated HTTP unit tests) the
// routes still register and every call fails closed (50001).
// B2-15o: GET /admin/v1/pay-refunds and GET /admin/v1/pay-refunds/{pay_refund_id}
// (listAdminPayRefunds, getAdminPayRefund; BR-PAY-06; 04 §6.6, §11.2) as the reads of
// pay-orders.controller.ts: the guard holds pay.view, read only (no step-up, an X-Step-Up-Token is
// neither read nor consumed); the app is the guard's actor, never a header; a refusal of the use
// case is 20001 data.fields; answers are no-store; reading writes no audit record. Without the
// database they fail closed (50001) too.
import {
  Body,
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
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  PayAdminFieldsError,
  PayAdminReads,
  type PayRefundListQuery,
} from '../../application/pay-admin-reads.ts';
import {
  createPayRefund,
  type PayRefundDeps,
  type PayRefundTarget,
} from '../../application/pay-refunds.ts';

/** Nest token of the use case dependencies (null in a process without database, queue or idempotency). */
export const PAY_REFUND_DEPS = Symbol('PAYMENT_PAY_REFUND_DEPS');

/** specs/permissions.yaml: pay.refund, step-up tier null. */
const PERMISSION = 'pay.refund';
/** specs/permissions.yaml: pay.view (step-up null). */
const VIEW = 'pay.view';

export interface AdminPayRefundRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handlers write on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminPayRefundRawReply {
  code(statusCode: number): AdminPayRefundRawReply;
  type(contentType: string): AdminPayRefundRawReply;
  send(payload: string): unknown;
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

function header(request: AdminPayRefundRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminPayRefundsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: PayRefundDeps | null;
  readonly #reads: PayAdminReads;

  constructor(guard: AdminOperationGuard, deps: PayRefundDeps | null, reads: PayAdminReads) {
    this.#guard = guard;
    this.#deps = deps;
    this.#reads = reads;
  }

  list(
    request: AdminPayRefundRequest,
    query: PayRefundListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayRefundPageResponse'>> {
    return this.#read(request, reply, (appId) => this.#reads.listRefunds(appId, query));
  }

  detail(
    request: AdminPayRefundRequest,
    payRefundId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayRefundResponse'>> {
    return this.#read(request, reply, (appId) => this.#reads.refundDetail(appId, payRefundId));
  }

  refundOrder(
    request: AdminPayRefundRequest,
    payOrderId: string,
    body: Schema<'AdminPayRefundCreateRequest'>,
    reply: AdminPayRefundRawReply,
  ): Promise<void> {
    return this.#refund(request, { type: 'pay_order', id: payOrderId }, body, reply);
  }

  refundAnomaly(
    request: AdminPayRefundRequest,
    payAnomalyId: string,
    body: Schema<'AdminPayRefundCreateRequest'>,
    reply: AdminPayRefundRawReply,
  ): Promise<void> {
    return this.#refund(request, { type: 'pay_anomaly', id: payAnomalyId }, body, reply);
  }

  async #refund(
    request: AdminPayRefundRequest,
    target: PayRefundTarget,
    body: Schema<'AdminPayRefundCreateRequest'>,
    reply: AdminPayRefundRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error(
          'payment: refunds need the database, the queue and the idempotency primitive',
        );
      }
      sent = await createPayRefund(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        target,
        { body, key: header(request, 'idempotency-key'), traceId: request.id },
      );
      // The guard reads the code (step-up consumption; none for pay.refund); the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('payment: admin guard returned without an answer');
    reply.code(sent.status).type('application/json; charset=utf-8').send(sent.body);
  }

  async #read<T>(
    request: AdminPayRefundRequest,
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
        if (error instanceof PayAdminFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('payment: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminPayRefundsController.prototype;
  Inject(AdminOperationGuard)(AdminPayRefundsController, undefined, 0);
  Inject(PAY_REFUND_DEPS)(AdminPayRefundsController, undefined, 1);
  Inject(PayAdminReads)(AdminPayRefundsController, undefined, 2);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('pay-refunds')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminPayRefunds'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('pay_refund_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('pay-refunds/:pay_refund_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminPayRefund'))(prototype, 'detail', detail);

  const order = Object.getOwnPropertyDescriptor(prototype, 'refundOrder')!;
  Req()(prototype, 'refundOrder', 0);
  Param('pay_order_id')(prototype, 'refundOrder', 1);
  Body()(prototype, 'refundOrder', 2);
  Res()(prototype, 'refundOrder', 3);
  Post('pay-orders/:pay_order_id/refunds')(prototype, 'refundOrder', order);
  HttpCode(200)(prototype, 'refundOrder', order);
  RouteSchema(contractRouteSchema('createAdminPayRefund'))(prototype, 'refundOrder', order);

  const anomaly = Object.getOwnPropertyDescriptor(prototype, 'refundAnomaly')!;
  Req()(prototype, 'refundAnomaly', 0);
  Param('pay_anomaly_id')(prototype, 'refundAnomaly', 1);
  Body()(prototype, 'refundAnomaly', 2);
  Res()(prototype, 'refundAnomaly', 3);
  Post('pay-anomalies/:pay_anomaly_id/refunds')(prototype, 'refundAnomaly', anomaly);
  HttpCode(200)(prototype, 'refundAnomaly', anomaly);
  RouteSchema(contractRouteSchema('createAdminPayAnomalyRefund'))(
    prototype,
    'refundAnomaly',
    anomaly,
  );

  Controller('admin/v1')(AdminPayRefundsController);
}
