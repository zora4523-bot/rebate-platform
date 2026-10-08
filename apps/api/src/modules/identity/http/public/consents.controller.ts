import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { ConsentService } from '../../application/consents.ts';
import { CONSENTS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

/** What this controller reads of the Fastify request, already checked by stages ② ③ and the schema. */
interface RecordConsentRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'RecordConsentRequest'>;
}

function header(request: RecordConsentRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class ConsentsController {
  constructor(@Inject(CONSENTS) private readonly consents: ConsentService | null) {}

  /**
   * Contract operation `recordConsent` (BR-ID-12, BR-ID-13): x-auth optional, not signed. With a
   * token the subject comes from it; without one from X-Device-Id, checked against the devices of
   * X-App-Id (application/consents.ts). The version gate and the session scopes belong to B1-03c.
   */
  @Post('consents')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('recordConsent'))
  async record(@Req() request: RecordConsentRequest): Promise<Schema<'EmptyResponse'>> {
    if (this.consents === null) {
      throw new Error('identity: consent records need the database');
    }
    const principal = tokenPrincipal(request);
    // After login the app comes from the token only (BR-ID-07); the schema requires X-App-Id.
    const appId = principal?.app_id ?? header(request, 'x-app-id');
    const deviceId = header(request, 'x-device-id');
    if (appId === undefined) throw new Error('identity: a consent needs X-App-Id');
    const result = await this.consents.record({
      app_id: appId,
      body: request.body,
      ...(principal === undefined ? {} : { principal }),
      ...(deviceId === undefined ? {} : { device_id: deviceId }),
    });
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: request.id };
    throw identityFailure(result, request.id);
  }
}
