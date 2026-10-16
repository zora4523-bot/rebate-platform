import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type CheckedRequest } from '../../../platform/index.ts';
import type { OauthLoginCommand, OauthLoginService } from '../../application/oauth-login.ts';
import { OAUTH_LOGIN } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';
import { smsLoginErrorResponse } from './sms-login.controller.ts';

interface LoginRequest extends CheckedRequest {
  readonly id: string;
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function header(request: LoginRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class OauthLoginController {
  constructor(@Inject(OAUTH_LOGIN) private readonly logins: OauthLoginService | null) {}

  @Post('auth/login/wechat')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('loginByWechat'))
  async wechat(
    @Req() request: LoginRequest & { body: Schema<'LoginByWechatRequest'> },
  ): Promise<Schema<'LoginResponse'>> {
    return this.login(request, { provider: 'wechat', body: request.body });
  }

  @Post('auth/login/apple')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('loginByApple'))
  async apple(
    @Req() request: LoginRequest & { body: Schema<'LoginByAppleRequest'> },
  ): Promise<Schema<'LoginResponse'>> {
    return this.login(request, { provider: 'apple', body: request.body });
  }

  private async login(
    request: LoginRequest,
    input:
      | { provider: 'wechat'; body: Schema<'LoginByWechatRequest'> }
      | { provider: 'apple'; body: Schema<'LoginByAppleRequest'> },
  ): Promise<Schema<'LoginResponse'>> {
    const device = request.verifiedDevice;
    if (this.logins === null || device === undefined) {
      throw new Error('identity: OAuth login needs stores and a verified device');
    }
    const channel = header(request, 'x-channel');
    const version = header(request, 'x-app-version');
    const command: OauthLoginCommand = {
      ...input,
      app_id: device.appId,
      device_id: device.deviceId,
      platform: header(request, 'x-platform') as ClientPlatform,
      ...(channel === undefined ? {} : { channel }),
      ...(version === undefined ? {} : { version }),
      client_ip: request.ip,
    };
    const result = await this.logins.login(command);
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: request.id };
    if (result.code === 10007) {
      throw new HttpException(
        { code: 10007, msg: '账号正在注销处理中', data: result.data, trace_id: request.id },
        403,
      );
    }
    if (result.code === 10405 || result.code === 44001) {
      const response = smsLoginErrorResponse(result, request.id);
      throw new HttpException(response.body, response.statusCode);
    }
    throw identityFailure(result, request.id);
  }
}
