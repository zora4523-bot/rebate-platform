import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type CheckedRequest } from '../../../platform/index.ts';
import type { RefreshResult, RefreshService } from '../../application/refresh.ts';
import { REFRESH } from '../../application/tokens.ts';

type TokenPairResponse = Schema<'TokenPairResponse'>;

/** What this controller reads of the Fastify request, already checked by stage ① ③ and the schema. */
interface RefreshRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'RefreshTokenRequest'>;
}

/**
 * Fallback texts (`msg`; clients show their dictionary text): 10404 is the package default of
 * BR-TEXT-14 (contracts/texts.default.json error.10404); 50001 is the global error filter's text.
 */
const MESSAGES = Object.freeze({
  10404: '登录已过期，请重新登录',
  50001: '服务端错误',
});

export interface RefreshErrorResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly msg: string; readonly trace_id: string };
}

/** contracts/error-codes.yaml statuses: 10404 401, 50001 500; neither carries data. */
export function refreshErrorResponse(
  result: Exclude<RefreshResult, { code: 0 }>,
  traceId: string,
): RefreshErrorResponse {
  switch (result.code) {
    case 10404:
      return { statusCode: 401, body: { code: 10404, msg: MESSAGES[10404], trace_id: traceId } };
    case 50001:
      return { statusCode: 500, body: { code: 50001, msg: MESSAGES[50001], trace_id: traceId } };
  }
}

/** A single header value as sent (the route schema already checked its form). */
function header(request: RefreshRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class RefreshController {
  constructor(@Inject(REFRESH) private readonly refreshes: RefreshService | null) {}

  /**
   * Contract operation `refreshToken` (04 §6.1; BR-ID-07): x-auth none (Authorization is never
   * read), x-signed, not idempotent, no version gate, both session scopes. Stage ① (request
   * signature) and the device-source check ③ have already run: the app and device are the verified
   * device's. X-Platform, X-Channel and X-App-Version decide the scope of a rotated pair
   * (application/refresh.ts).
   */
  @Post('auth/refresh')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('refreshToken'))
  async refresh(@Req() request: RefreshRequest): Promise<TokenPairResponse> {
    const device = request.verifiedDevice;
    if (this.refreshes === null || device === undefined) {
      throw new Error('identity: refresh needs the database, Redis, the field cipher and a device');
    }
    const channel = header(request, 'x-channel');
    const version = header(request, 'x-app-version');
    const result = await this.refreshes.refresh({
      refresh_token: request.body.refresh_token,
      verifiedDevice: { deviceId: device.deviceId, appId: device.appId },
      platform: header(request, 'x-platform') as ClientPlatform,
      ...(channel === undefined ? {} : { channel }),
      ...(version === undefined ? {} : { version }),
    });
    if (result.code === 0) {
      return { code: 0, msg: '', data: result.data, trace_id: request.id };
    }
    const response = refreshErrorResponse(result, request.id);
    throw new HttpException(response.body, response.statusCode);
  }
}
