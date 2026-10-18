// Contract operation `bindInviter` (POST /v1/me/inviter: x-auth phone, x-signed, x-idempotent,
// version gate) — task B1-11e; 08 BR-INV-02, BR-INV-03, BR-INV-07, BR-INV-08. HTTP entry only: every
// check and the write are growth's binding core (B1-11d, createInviteBinder) on the backfill
// channel; nothing here judges a rule.
//
// - The subject is the verified token (stage ②: uid, app_id) and the verified signature device
//   (stage ①: device_id); the body carries invite_code only (the contract schema refuses any other
//   field with 20001 before this handler runs). The raw invite_code goes to the core unchanged
//   (the core normalises it, BR-INV-02).
// - The core runs inside platform idempotency's transactional mode (executeInTransaction): the
//   relation write, its relation_change_logs row and the key's `completed` record commit together.
//   The idempotency module stores code 0 and 3xxxx results (a replay answers them byte for byte
//   without calling the core again, so a replayed 30401 is never counted twice); 10005, 42901 and
//   50001 are not stored and roll everything back, so the same key may be sent again. A core that
//   throws rolls back and the global filter answers 50001.
// - Codes as the core returns them, HTTP status from contracts/error-codes.yaml, msg the BR-TEXT-14
//   fallback text (clients show their dictionary text error.<code>); 3xxxx envelopes have no data.
//   42901 carries Retry-After, the core's seconds up to the next 00:00 +08:00.
// - The daily 30401 count is in Redis, outside the transaction: the core gets the Idempotency-Key
//   as its attempt key and counts one key once (a retry after a rolled-back commit — no record
//   survives it — never counts again; review r1 S1).
// - Stages ①–⑧ (signature, token, app, version gate, risk state, phone level 10005) are the
//   global guard's and the idempotency post-miss hooks', not judged here.
// Without the core (no database, Redis, field cipher or event bus) or the idempotency primitive the
// route fails closed with 50001.
//
// Also compiled by the `test` project (through ../../index.ts): Nest metadata is applied by plain
// calls below, no parameter properties.
import { Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { errorCodes, type Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import type { InviteBinder, InviteBindingResult } from '../../application/invite-binder.ts';

/** Nest token of growth's binding core for this route (null when it cannot be assembled). */
export const INVITE_BACKFILL_BINDER = Symbol('GROWTH_INVITE_BACKFILL_BINDER');

const PATH = '/v1/me/inviter';

type FailureCode = Extract<InviteBindingResult, { result: 'failed' }>['code'];

/** BR-TEXT-14 fallback texts (contracts/texts.default.json error.<code>, no placeholders). */
const MESSAGES: Readonly<Record<FailureCode, string>> = Object.freeze({
  10005: '请先绑定手机号',
  30401: '邀请码无效',
  30402: '已绑定邀请人，不能重复绑定',
  30403: '不能绑定该邀请人',
  30404: '已超过补填邀请码的期限',
  30408: '邀请活动暂停',
  30409: '已有订单、找回申请或邀请记录，不能补填或修改邀请人',
  42901: '操作太频繁，请稍后再试',
  // The global error filter's 50001 text.
  50001: '服务端错误',
});

/** What this controller reads of the Fastify request, already checked by stages ①–③ and the schema. */
export interface InviterHttpRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: Schema<'BindInviterRequest'>;
}

/** What this controller writes on the Fastify reply. */
export interface InviterRawReply {
  code(statusCode: number): InviterRawReply;
  header(name: string, value: string): InviterRawReply;
  type(contentType: string): InviterRawReply;
  send(payload: string): unknown;
}

/** The core's answer as the response envelope; `retryAfter` only for 42901. */
function answer(
  result: InviteBindingResult,
  traceId: string,
): { readonly response: HandlerResult; readonly retryAfter?: number } {
  if (result.result === 'bound') {
    const envelope: Schema<'EmptyResponse'> = { code: 0, msg: '', data: {}, trace_id: traceId };
    return { response: { status: 200, envelope } };
  }
  const { code } = result;
  if (!Object.hasOwn(MESSAGES, code)) throw new Error('growth: unexpected invite bind code');
  const response: HandlerResult = {
    status: errorCodes[code].http,
    envelope: { code, msg: MESSAGES[code], trace_id: traceId },
  };
  if (code !== 42901) return { response };
  const seconds = result.retry_after_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    // Retry-After is required on 42901 (contract TooManyRequests): a programming error.
    throw new Error('growth: 42901 without retry_after_seconds');
  }
  return { response, retryAfter: Math.max(1, Math.ceil(seconds)) };
}

export class InviterController {
  readonly #binder: InviteBinder | null;
  readonly #idempotency: Idempotency | undefined;

  constructor(binder: InviteBinder | null, idempotency: Idempotency | undefined) {
    this.#binder = binder;
    this.#idempotency = idempotency;
  }

  async bindInviter(request: InviterHttpRequest, reply: InviterRawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const device = request.verifiedDevice;
    const binder = this.#binder;
    const idempotency = this.#idempotency;
    if (
      principal === undefined ||
      device === undefined ||
      binder === null ||
      idempotency === undefined
    ) {
      throw new Error('growth: invite backfill needs the core, a verified token and device');
    }
    // Stage ③ already ties X-App-Id to the token; the signing device must be of the same app.
    if (device.appId !== principal.app_id) {
      throw new Error('growth: signature device and token belong to different apps');
    }
    const body = request.body!;
    const header = request.headers['idempotency-key'];
    const key = typeof header === 'string' ? header : undefined;
    const traceId = request.id;
    let retryAfter: number | undefined;
    const result = await idempotency.executeInTransaction(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: device.deviceId, phoneHmac: null },
        method: 'POST',
        path: PATH,
        key,
        body,
        traceId,
      },
      async (trx): Promise<HandlerResult> => {
        const outcome = answer(
          await binder.bind(
            trx,
            {
              channel: 'backfill',
              app_id: principal.app_id,
              user_id: principal.uid,
              device_id: device.deviceId,
              invite_code: body.invite_code,
            },
            // The handler runs only with a well-formed key (the idempotency module answers 20001
            // otherwise): the daily 30401 count is de-duplicated per key (review r1 S1).
            key === undefined ? undefined : { attemptKey: key },
          ),
          traceId,
        );
        retryAfter = outcome.retryAfter;
        return outcome.response;
      },
    );
    // Only an answer of the core in this call carries the header (42901 is never stored).
    if (result.source === 'handler' && retryAfter !== undefined) {
      reply.header('Retry-After', String(retryAfter));
    }
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}

{
  const prototype = InviterController.prototype;
  const bindInviter = Object.getOwnPropertyDescriptor(prototype, 'bindInviter')!;
  Inject(INVITE_BACKFILL_BINDER)(InviterController, undefined, 0);
  Inject(IDEMPOTENCY)(InviterController, undefined, 1);
  Optional()(InviterController, undefined, 1);
  Req()(prototype, 'bindInviter', 0);
  Res()(prototype, 'bindInviter', 1);
  Post('me/inviter')(prototype, 'bindInviter', bindInviter);
  HttpCode(200)(prototype, 'bindInviter', bindInviter);
  RouteSchema(contractRouteSchema('bindInviter'))(prototype, 'bindInviter', bindInviter);
  Controller('v1')(InviterController);
}
