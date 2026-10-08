import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { H5TokenService } from '../../application/h5-token.ts';
import { H5_TOKENS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

/** What this controller reads of the Fastify request, already checked by stages ② ③ and the schema. */
interface IssueH5TokenRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly body: Schema<'IssueH5TokenRequest'>;
}

@Controller('v1')
export class H5TokenController {
  constructor(@Inject(H5_TOKENS) private readonly h5Tokens: H5TokenService | null) {}

  /**
   * Contract operation `issueH5Token` (BR-ID-32): x-auth login, not signed. An h5_token itself is
   * refused here by the token check (10403: /v1/auth/** is outside its scope). The version gate
   * and the session scope (10405) belong to B1-03c.
   */
  @Post('auth/h5-token')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('issueH5Token'))
  async issue(@Req() request: IssueH5TokenRequest): Promise<Schema<'H5TokenResponse'>> {
    const principal = tokenPrincipal(request);
    // Unreachable behind stage ②; never answer 200 for a request no token check vouched for.
    if (principal === undefined) {
      throw new Error('identity: h5-token without a verified access token');
    }
    if (this.h5Tokens === null) {
      throw new Error('identity: h5 tokens need the database and the configuration reader');
    }
    const result = await this.h5Tokens.issue({ principal, body: request.body });
    if (result.code === 0) return { code: 0, msg: '', data: result.data, trace_id: request.id };
    throw identityFailure(result, request.id);
  }
}
