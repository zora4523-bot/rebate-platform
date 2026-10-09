import { Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, fieldsErrorEnvelope } from '../../../platform/index.ts';
import { RegisterDeviceService } from '../../application/register-device.service.ts';

type RegisterDeviceResponse = Schema<'RegisterDeviceResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface RegisterDeviceRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address, as the SMS routes and the rate limits read it. */
  readonly ip: string;
  readonly headers: {
    readonly 'x-app-id': string;
    readonly 'x-platform': string;
    readonly 'x-app-version': string;
  };
  readonly body: Schema<'RegisterDeviceRequest'>;
}

/** What this controller writes on the Fastify reply besides the body. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** Fallback text of 42901 (BR-TEXT-14 package default error.42901, as the SMS route). */
const RATE_LIMITED_MSG = '操作太频繁，请稍后再试';

@Controller('v1')
export class DevicesController {
  constructor(
    @Inject(RegisterDeviceService) private readonly registerDevice: RegisterDeviceService,
  ) {}

  /**
   * Contract operation `registerDevice`: x-auth none, not signed. A hash on the invalid list is
   * 20001 with data.fields=[device_hash], the same envelope the request schema gives a hash of
   * the wrong format, and no device_id is issued (BR-ID-09 细则「设备标识的无效值」). Reaching the
   * per-IP hourly registration limit is 42901 with Retry-After, nothing issued (BR-ID-05).
   */
  @Post('devices')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('registerDevice'))
  async register(
    @Req() request: RegisterDeviceRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<RegisterDeviceResponse> {
    const result = await this.registerDevice.register({
      appId: request.headers['x-app-id'],
      platform: request.headers['x-platform'],
      appVersion: request.headers['x-app-version'],
      deviceHash: request.body.device_hash,
      idSource: request.body.id_source,
      clientIp: request.ip,
    });
    if (result.kind === 'invalid_device_hash') {
      const { statusCode, body } = fieldsErrorEnvelope(['device_hash'], request.id);
      throw new HttpException(body, statusCode);
    }
    if (result.kind === 'rate_limited') {
      reply.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterSec))));
      throw new HttpException({ code: 42901, msg: RATE_LIMITED_MSG, trace_id: request.id }, 429);
    }
    return {
      code: 0,
      msg: '',
      data: { device_id: result.deviceId, install_secret: result.installSecret },
      trace_id: request.id,
    };
  }
}
