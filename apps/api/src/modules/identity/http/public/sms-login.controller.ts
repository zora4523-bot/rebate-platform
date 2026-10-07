import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type CheckedRequest } from '../../../platform/index.ts';
import type { SmsLoginResult, SmsLoginService } from '../../application/sms-login.ts';
import { SMS_LOGIN } from '../../application/tokens.ts';

type LoginResponse = Schema<'LoginResponse'>;

/** What this controller reads of the Fastify request, already checked by stage ① ③ and the schema. */
interface SmsLoginRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address (no proxy trust is configured yet; B1-03g decides). */
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'LoginBySmsRequest'>;
}

/**
 * Fallback texts (`msg`; clients show their dictionary text): the package defaults of BR-TEXT-14
 * (contracts/texts.default.json error.<code>[.<reason>]); 50001 is the global error filter's text.
 */
const MESSAGES = Object.freeze({
  phone_invalid: '请输入 11 位中国大陆手机号',
  20002: '验证码错误，请重新输入',
  20003: '验证码已失效，请重新获取',
  44001: '操作未通过安全校验',
  no_account: '这个账号还没有注册，请先更新 App 再注册',
  50001: '服务端错误',
});

export interface SmsLoginErrorResponse {
  readonly statusCode: number;
  readonly body: {
    readonly code: number;
    readonly msg: string;
    readonly data?: Readonly<Record<string, unknown>>;
    readonly trace_id: string;
  };
}

/**
 * The HTTP answer of a refused login (contracts/error-codes.yaml statuses): 20001 / 20002 / 20003
 * 400 (20001 with data.fields=[phone], data.reason=phone_invalid); 44001 403 with
 * data.risk_msg_code only when the result carries one; 10405 403 with data.reason=no_account and
 * data.min_supported_version (null when the minimum is no longer configured); 50001 500.
 */
export function smsLoginErrorResponse(
  result: Exclude<SmsLoginResult, { code: 0 }>,
  traceId: string,
): SmsLoginErrorResponse {
  switch (result.code) {
    case 20001:
      return {
        statusCode: 400,
        body: {
          code: 20001,
          msg: MESSAGES.phone_invalid,
          data: { fields: [...result.data.fields], reason: result.data.reason },
          trace_id: traceId,
        },
      };
    case 20002:
    case 20003:
      return {
        statusCode: 400,
        body: { code: result.code, msg: MESSAGES[result.code], trace_id: traceId },
      };
    case 44001:
      return {
        statusCode: 403,
        body: {
          code: 44001,
          msg: MESSAGES[44001],
          ...(result.data === undefined
            ? {}
            : { data: { risk_msg_code: result.data.risk_msg_code } }),
          trace_id: traceId,
        },
      };
    case 10405:
      return {
        statusCode: 403,
        body: {
          code: 10405,
          msg: MESSAGES.no_account,
          data: {
            reason: result.data.reason,
            min_supported_version: result.data.min_supported_version,
          },
          trace_id: traceId,
        },
      };
    case 50001:
      return { statusCode: 500, body: { code: 50001, msg: MESSAGES[50001], trace_id: traceId } };
  }
}

/** A single header value as sent (the route schema already checked its form). */
function header(request: SmsLoginRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class SmsLoginController {
  constructor(@Inject(SMS_LOGIN) private readonly logins: SmsLoginService | null) {}

  /**
   * Contract operation `loginBySms` (04 §6.1; BR-ID-01 / 04 / 05, BR-INV-06): x-auth none,
   * x-signed, not idempotent, no version gate, both session scopes. Stage ① (request signature)
   * and the device-source check ③ have already run: the app and device are the verified device's,
   * never the body's. X-Platform, X-Channel and X-App-Version decide the session scope
   * (application/sms-login.ts).
   */
  @Post('auth/login/sms')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('loginBySms'))
  async login(@Req() request: SmsLoginRequest): Promise<LoginResponse> {
    const device = request.verifiedDevice;
    if (this.logins === null || device === undefined) {
      throw new Error('identity: SMS login needs the database, Redis and a verified device');
    }
    const channel = header(request, 'x-channel');
    const version = header(request, 'x-app-version');
    const result = await this.logins.login({
      body: request.body,
      app_id: device.appId,
      device_id: device.deviceId,
      platform: header(request, 'x-platform') as ClientPlatform,
      ...(channel === undefined ? {} : { channel }),
      ...(version === undefined ? {} : { version }),
      client_ip: request.ip,
    });
    if (result.code === 0) {
      return { code: 0, msg: '', data: result.data, trace_id: request.id };
    }
    const response = smsLoginErrorResponse(result, request.id);
    throw new HttpException(response.body, response.statusCode);
  }
}
