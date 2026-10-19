import { Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { SmsCodeService } from '../../application/sms-codes.ts';
import { SMS_CODES } from '../../application/tokens.ts';
import { smsErrorResponse } from './sms-codes.controller.ts';

type SendSmsCodeResponse = Schema<'SendSmsCodeResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface LandingSmsCodeRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address (proxy trust only from the configured trusted proxies). */
  readonly ip: string;
  readonly headers: { readonly 'x-app-id': string };
  readonly body: Schema<'LandingSmsCodeRequest'>;
}

/** What this controller writes on the Fastify reply besides the body. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

@Controller('v1')
export class LandingSmsCodesController {
  constructor(@Inject(SMS_CODES) private readonly smsCodes: SmsCodeService | null) {}

  /**
   * Contract operation `sendLandingSmsCode` (BR-ID-32, BR-ID-05): x-auth none, not signed, no
   * device, no version gate, no human verification. The code is a purpose=login code of the app
   * named by X-App-Id; the order is 20001 → 44001 → 42901 (the two per-IP items, then the phone
   * quota shared with the app route). Nothing is issued besides the SMS: no token, no cookie.
   */
  @Post('landing/sms-codes')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('sendLandingSmsCode'))
  async send(
    @Req() request: LandingSmsCodeRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SendSmsCodeResponse> {
    if (this.smsCodes === null) {
      throw new Error('identity: SMS codes need Redis and the database');
    }
    const result = await this.smsCodes.send({
      app_id: request.headers['x-app-id'],
      phone: request.body.phone,
      purpose: 'login',
      client_ip: request.ip,
      channel: 'landing',
    });
    if (result.code === 0) {
      return { code: 0, msg: '', data: result.data, trace_id: request.id };
    }
    const response = smsErrorResponse(result, request.id);
    if (response.retryAfterSec !== undefined) {
      reply.header('Retry-After', String(response.retryAfterSec));
    }
    throw new HttpException(response.body, response.statusCode);
  }
}
