// B2-15c: the notification entry of the two channels, POST /notify/pay/wechat and
// POST /notify/pay/alipay (08 BR-PAY-04 and 细则「通知应答」, BR-PAY-08 ③; specs/pay-notify.md;
// task §9.1, §9.8). Outside the client contract (no operationId, no route schema), on the api
// process only: no login state, no request signature header, no X-App-Id is read — the request
// checks of the entry leave a route outside the contract alone, and the only authentication is
// the channel signature the adapter verifies (application/pay-notifications.ts). Before that, the
// per-address limit (infra/notify-rate-limit.ts).
//
// The answer carries no business information at all (BR-PAY-04 细则: 不返回业务信息; 20902 is never
// used here) — one fixed body per outcome in the channel's own format, so every «success» answer is
// byte for byte the same and so is every «not success» one:
//   WeChat Pay  success: HTTP 200, JSON {"code":"SUCCESS","message":"成功"};
//               not success: HTTP 500, JSON {"code":"FAIL","message":"失败"}
//               (docs-mirror/wechat-pay/pages/4013070368.txt: 200 / 204 count as received, any
//               other status makes the platform re-send; the body shape is {code, message}; 待实测);
//   Alipay      success: HTTP 200, text `success`; not success: HTTP 200, text `failure`
//               (docs-mirror/alipay/app-pay/00dn78.md: the platform reads the body text; 待实测).
// Every failure of our own side — the use case throwing, a missing dependency — is answered «not
// success» too (the channel re-sends), with the error class alone in the log. Nothing of the
// request (headers, body, address) is logged here.
// Without the database, the queue or the field cipher the entry is not assembled at all
// (payment.module.ts), so there is no route to answer.
import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { RootLogger } from '../../../platform/index.ts';
import type { NotifyAnswer, PayNotificationDeps } from '../../application/pay-notifications.ts';
import { handlePayNotification } from '../../application/pay-notifications.ts';
import type { PayChannelCode } from '../../domain/types.ts';
import type { NotifyRateLimiter } from '../../infra/notify-rate-limit.ts';
import { NOTIFY_RAW_BODY, notifyRawBodyOf } from './notify-body.ts';

/** Nest token of the entry's dependencies. */
export const PAY_NOTIFY_DEPS = Symbol('PAYMENT_PAY_NOTIFY_DEPS');

export interface PayNotifyDeps {
  readonly handler: PayNotificationDeps;
  /** null: no Redis in this process (announced once at start); nothing is limited then. */
  readonly rateLimiter: NotifyRateLimiter | null;
  readonly logger: RootLogger;
}

/** The notification routes (Fastify templates), for the body capture's route filter. */
export const NOTIFY_ROUTE_PREFIX = '/notify/pay/';
export const NOTIFY_ROUTES: Readonly<Record<PayChannelCode, string>> = Object.freeze({
  wechat_pay: `${NOTIFY_ROUTE_PREFIX}wechat`,
  alipay: `${NOTIFY_ROUTE_PREFIX}alipay`,
});

export function isNotifyRoute(method: string, routeTemplate: string): boolean {
  return (
    method.toUpperCase() === 'POST' &&
    Object.values(NOTIFY_ROUTES).some((route) => route === routeTemplate)
  );
}

/** What the handlers read of the Fastify request. */
export interface PayNotifyHttpRequest {
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly [NOTIFY_RAW_BODY]?: Buffer;
}

export interface PayNotifyRawReply {
  code(statusCode: number): PayNotifyRawReply;
  type(contentType: string): PayNotifyRawReply;
  send(payload: string): unknown;
}

interface Answer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** The fixed answers (see the header): one per channel and outcome, nothing else ever. */
export const ANSWERS: Readonly<Record<PayChannelCode, Readonly<Record<NotifyAnswer, Answer>>>> =
  Object.freeze({
    wechat_pay: Object.freeze({
      ack: Object.freeze({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ code: 'SUCCESS', message: '成功' }),
      }),
      nack: Object.freeze({
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ code: 'FAIL', message: '失败' }),
      }),
    }),
    alipay: Object.freeze({
      ack: Object.freeze({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: 'success',
      }),
      nack: Object.freeze({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: 'failure',
      }),
    }),
  });

/** The request headers as single strings (a repeated header joined as Node sends it). */
function flatHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<Record<string, string>> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') flat[name] = value;
    else if (Array.isArray(value)) flat[name] = value.join(', ');
  }
  return flat;
}

export class PayNotifyController {
  readonly #deps: PayNotifyDeps;

  constructor(deps: PayNotifyDeps) {
    this.#deps = deps;
  }

  wechat(request: PayNotifyHttpRequest, reply: PayNotifyRawReply): Promise<void> {
    return this.#handle('wechat_pay', request, reply);
  }

  alipay(request: PayNotifyHttpRequest, reply: PayNotifyRawReply): Promise<void> {
    return this.#handle('alipay', request, reply);
  }

  async #handle(
    channel: PayChannelCode,
    request: PayNotifyHttpRequest,
    reply: PayNotifyRawReply,
  ): Promise<void> {
    const answer = ANSWERS[channel][await this.#decide(channel, request)];
    reply.code(answer.status).type(answer.contentType).send(answer.body);
  }

  async #decide(channel: PayChannelCode, request: PayNotifyHttpRequest): Promise<NotifyAnswer> {
    const { handler, rateLimiter, logger } = this.#deps;
    try {
      if (rateLimiter !== null) {
        const allowed = await rateLimiter.allow(channel, request.ip ?? '');
        if (!allowed) {
          logger.warn({ pay_channel: channel, trace_id: request.id }, 'pay_notify_rate_limited');
          return 'nack';
        }
      }
      return await handlePayNotification(handler, channel, {
        headers: flatHeaders(request.headers),
        body: notifyRawBodyOf(request).toString('utf8'),
      });
    } catch (error: unknown) {
      // Rolled back by the use case; the channel re-sends (BR-PAY-04 细则 应答表 last row).
      logger.warn(
        {
          pay_channel: channel,
          trace_id: request.id,
          error_class: error instanceof Error ? error.name : typeof error,
        },
        'pay_notify_failed',
      );
      return 'nack';
    }
  }
}

{
  const prototype = PayNotifyController.prototype;
  const wechat = Object.getOwnPropertyDescriptor(prototype, 'wechat')!;
  const alipay = Object.getOwnPropertyDescriptor(prototype, 'alipay')!;
  Inject(PAY_NOTIFY_DEPS)(PayNotifyController, undefined, 0);
  Req()(prototype, 'wechat', 0);
  Res()(prototype, 'wechat', 1);
  Post('wechat')(prototype, 'wechat', wechat);
  Req()(prototype, 'alipay', 0);
  Res()(prototype, 'alipay', 1);
  Post('alipay')(prototype, 'alipay', alipay);
  Controller('notify/pay')(PayNotifyController);
}
