import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { OauthAttemptService } from '../../application/oauth-attempts.ts';
import { OAUTH_ATTEMPTS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

/** What this controller reads of the Fastify request, already checked by stages ① ② ③ and the schema. */
interface CreateOauthAttemptRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly body: Schema<'CreateOauthAttemptRequest'>;
}

@Controller('v1')
export class OauthAttemptsController {
  constructor(@Inject(OAUTH_ATTEMPTS) private readonly attempts: OauthAttemptService | null) {}

  /**
   * Contract operation `createOauthAttempt` (BR-ID-04 细则「授权尝试」): x-auth optional, x-signed.
   * The attempt is bound to the verified device of stage ① and, for step_up / payout_bind, to the
   * token's user (application/oauth-attempts.ts). The version gate and the session scopes
   * (x-min-version-gate conditional, x-session-scopes) belong to B1-03c.
   */
  @Post('auth/oauth-attempts')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('createOauthAttempt'))
  async create(@Req() request: CreateOauthAttemptRequest): Promise<Schema<'OauthAttemptResponse'>> {
    const device = request.verifiedDevice;
    if (this.attempts === null || device === undefined) {
      throw new Error('identity: oauth attempts need Redis, the database and a verified device');
    }
    const principal = tokenPrincipal(request);
    const result = await this.attempts.issue({
      body: request.body,
      verifiedDevice: device,
      ...(principal === undefined ? {} : { principal }),
    });
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: request.id };
    throw identityFailure(result, request.id);
  }
}
