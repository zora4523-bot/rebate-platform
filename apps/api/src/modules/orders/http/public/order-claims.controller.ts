// B1-10b: POST /v1/orders/claims (createOrderClaim: x-auth login, x-signed, x-idempotent, version
// gate) and GET /v1/orders/claims (listOrderClaims: x-auth login, Cursor / Limit). A thin wrapper
// over application/order-claims.ts: the subject is the token principal only (app_id, uid →
// user_id; BR-AI-03), never a header, query or body field (the contract schema refuses any extra
// body field with 20001 before the handler runs).
// - Submission runs in platform idempotency's standard mode (execute): stages ④a and after are the
//   idempotency post-miss hooks' (version gate 10405 writes no record); the acceptance commits its
//   own transaction. Stored results are the idempotency module's rule (0 and 3xxxx: a replay
//   answers them byte for byte without judging or counting again); 20001 and 50001 are not stored,
//   so the same key may be sent again.
// - Codes and HTTP status as contracts/error-codes.yaml; msg the BR-TEXT-14 fallback text
//   (contracts/texts.default.json error.<code>[.<reason>]); 30201 / 30204 / 30205 / 30206 and the
//   daily-limit 30203 carry no data, 30202 and the risk 30203 only {reason}.
// Without a database (no acceptance, no idempotency primitive) both routes fail closed with 50001;
// without Redis the submission answers 50001 and the list still works.
//
// Nest's decorators are applied as plain calls (erasable syntax, as in orders.controller.ts).
import { errorCodes, type Schema } from '@couli/contracts-ts';
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import {
  createOrderClaim,
  listOrderClaims,
  type ClaimFailure,
  type OrderClaimDeps,
} from '../../application/order-claims.ts';
import type { OrderSubject } from '../../application/order-queries.ts';

/** Nest token of the claim ports (null when the entry has no database). */
export const ORDER_CLAIM_DEPS = Symbol('ORDER_CLAIM_DEPS');

const PATH = '/v1/orders/claims';

/** BR-TEXT-14 fallback texts (contracts/texts.default.json). */
const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  30201: '没有找到可以找回的订单，请核对订单号；刚下单的订单可能还未同步，请稍后再试',
  30202: '这笔订单暂不能找回',
  '30202.ALREADY_YOURS': '这笔订单已在你的订单列表中',
  '30202.CLAIM_EXPIRED': '已超过找回期限，无法提交',
  '30202.FACTOR_MISMATCH': '付款日期与订单不符，请核对后重新填写（预售订单填付定金日期）',
  '30202.ORDER_INVALID': '这笔订单已失效，无法找回',
  30203: '今日找回次数已用完，请明天再试',
  '30203.RISK_BLOCKED': '今日暂时无法提交找回，请明天再试',
  30204: '这笔订单已被认领，无法找回',
  30205: '你已提交过这笔订单的找回',
  30206: '找回功能暂时关闭，请稍后再试',
  // The global error filter's 50001 text.
  50001: '服务端错误',
});

export interface OrderClaimsHttpRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: Schema<'CreateOrderClaimRequest'>;
  readonly query?: { readonly cursor?: string; readonly limit?: number };
}

export interface OrderClaimsRawReply {
  code(statusCode: number): OrderClaimsRawReply;
  type(contentType: string): OrderClaimsRawReply;
  send(payload: string): unknown;
}

/** A refusal of the use case as the response envelope (keys code, msg, data, trace_id). */
function refusal(failure: ClaimFailure, traceId: string): HandlerResult {
  if (failure.code === 20001) {
    const fields =
      failure.data !== undefined && 'fields' in failure.data ? failure.data.fields : [];
    const refused = fieldsErrorEnvelope(fields, traceId);
    return { status: refused.statusCode, envelope: refused.body };
  }
  const reason =
    failure.data !== undefined && 'reason' in failure.data ? failure.data.reason : undefined;
  const msg =
    (reason === undefined ? undefined : MESSAGES[`${failure.code}.${reason}`]) ??
    MESSAGES[failure.code] ??
    '';
  return {
    status: errorCodes[failure.code].http,
    envelope: {
      code: failure.code,
      msg,
      ...(failure.data === undefined ? {} : { data: failure.data }),
      trace_id: traceId,
    },
  };
}

function subjectOf(principal: TokenPrincipal): OrderSubject {
  return { app_id: principal.app_id, user_id: principal.uid };
}

export class OrderClaimsController {
  readonly #deps: OrderClaimDeps | null;
  readonly #idempotency: Idempotency | undefined;

  constructor(deps: OrderClaimDeps | null, idempotency: Idempotency | undefined) {
    this.#deps = deps;
    this.#idempotency = idempotency;
  }

  async create(request: OrderClaimsHttpRequest, reply: OrderClaimsRawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const deps = this.#deps;
    const idempotency = this.#idempotency;
    if (principal === undefined || deps === null || idempotency === undefined) {
      throw new Error('orders: claim submission needs the database and a verified token');
    }
    const body = request.body!;
    const key = request.headers['idempotency-key'];
    const traceId = request.id;
    const subject = subjectOf(principal);
    const result = await idempotency.execute(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method: 'POST',
        path: PATH,
        key: typeof key === 'string' ? key : undefined,
        body,
        traceId,
      },
      async (): Promise<HandlerResult> => {
        const outcome = await createOrderClaim(deps, subject, body);
        if (outcome.code !== 0) return refusal(outcome, traceId);
        const envelope: Schema<'OrderClaimResponse'> = {
          code: 0,
          msg: '',
          data: outcome.data,
          trace_id: traceId,
        };
        return { status: 200, envelope };
      },
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }

  async list(request: OrderClaimsHttpRequest): Promise<Schema<'OrderClaimListResponse'>> {
    const principal = tokenPrincipal(request);
    const deps = this.#deps;
    if (principal === undefined || deps === null) {
      throw new Error('orders: claim records need the database and a verified token');
    }
    const query = request.query ?? {};
    const outcome = await listOrderClaims(deps, subjectOf(principal), {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    if (outcome.code === 0) return { code: 0, msg: '', data: outcome.data, trace_id: request.id };
    if (outcome.code === 50001) throw new Error('orders: claim records unavailable');
    const refused = refusal(outcome, request.id);
    throw new HttpException(refused.envelope, refused.status);
  }
}

{
  const prototype = OrderClaimsController.prototype;
  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Inject(ORDER_CLAIM_DEPS)(OrderClaimsController, undefined, 0);
  Inject(IDEMPOTENCY)(OrderClaimsController, undefined, 1);
  Optional()(OrderClaimsController, undefined, 1);
  Req()(prototype, 'create', 0);
  Res()(prototype, 'create', 1);
  Post()(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('createOrderClaim'))(prototype, 'create', create);
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listOrderClaims'))(prototype, 'list', list);
  Controller('v1/orders/claims')(OrderClaimsController);
}
