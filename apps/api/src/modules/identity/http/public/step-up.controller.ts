import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { StepUpService } from '../../application/step-up.ts';
import { STEP_UP } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

/** What this controller reads of the Fastify request, already checked by stages ① ② ③ and the schema. */
interface StepUpRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly body: Schema<'StepUpRequest'>;
}

@Controller('v1')
export class StepUpController {
  constructor(@Inject(STEP_UP) private readonly stepUp: StepUpService | null) {}

  /**
   * Contract operation `stepUp` (BR-ID-08): x-auth login, x-signed. The token check already
   * answered a missing (10001), invalid or revoked (10002) token and a foreign X-App-Id (10403);
   * the schema's oneOf refused a body mixing two ways (20001). The version gate and the session
   * scopes belong to B1-03c.
   */
  @Post('auth/step-up')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('stepUp'))
  async verify(@Req() request: StepUpRequest): Promise<Schema<'StepUpResponse'>> {
    const principal = tokenPrincipal(request);
    const device = request.verifiedDevice;
    // Unreachable behind stages ① ②; never answer 200 for a request they did not vouch for.
    if (principal === undefined || device === undefined) {
      throw new Error('identity: step-up without a verified access token and device');
    }
    if (this.stepUp === null) {
      throw new Error('identity: step-up needs the database, Redis and the field cipher');
    }
    const result = await this.stepUp.verify({
      body: request.body,
      principal,
      verifiedDevice: device,
    });
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: request.id };
    throw identityFailure(result, request.id);
  }
}
