import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, fieldsErrorEnvelope } from '../../../platform/index.ts';
import { RegisterDeviceService } from '../../application/register-device.service.ts';

type RegisterDeviceResponse = Schema<'RegisterDeviceResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface RegisterDeviceRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: {
    readonly 'x-app-id': string;
    readonly 'x-platform': string;
    readonly 'x-app-version': string;
  };
  readonly body: Schema<'RegisterDeviceRequest'>;
}

@Controller('v1')
export class DevicesController {
  constructor(
    @Inject(RegisterDeviceService) private readonly registerDevice: RegisterDeviceService,
  ) {}

  /**
   * Contract operation `registerDevice`: x-auth none, not signed. A hash on the invalid list is
   * 20001 with data.fields=[device_hash], the same envelope the request schema gives a hash of
   * the wrong format, and no device_id is issued (BR-ID-09 细则「设备标识的无效值」).
   */
  @Post('devices')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('registerDevice'))
  async register(@Req() request: RegisterDeviceRequest): Promise<RegisterDeviceResponse> {
    const result = await this.registerDevice.register({
      appId: request.headers['x-app-id'],
      platform: request.headers['x-platform'],
      appVersion: request.headers['x-app-version'],
      deviceHash: request.body.device_hash,
      idSource: request.body.id_source,
    });
    if (result.kind === 'invalid_device_hash') {
      const { statusCode, body } = fieldsErrorEnvelope(['device_hash'], request.id);
      throw new HttpException(body, statusCode);
    }
    return {
      code: 0,
      msg: '',
      data: { device_id: result.deviceId, install_secret: result.installSecret },
      trace_id: request.id,
    };
  }
}
