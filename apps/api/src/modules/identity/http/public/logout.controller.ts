import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { Logout } from '../../application/logout.ts';
import { LOGOUT } from '../../application/tokens.ts';

type LogoutResponse = Schema<'EmptyResponse'>;

/** What this controller reads of the Fastify request, already checked by stages ② ③ and the schema. */
interface LogoutRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

@Controller('v1')
export class LogoutController {
  constructor(@Inject(LOGOUT) private readonly logouts: Logout) {}

  /**
   * Contract operation `logout` (04 §6.1): x-auth login, not signed, not idempotent, no version
   * gate, both session scopes. The token check at the registration point already answered a
   * missing (10001), invalid or revoked (10002) token and a foreign X-App-Id (10403); the session
   * revoked here is the one of that verified token (application/logout.ts).
   */
  @Post('auth/logout')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('logout'))
  async logout(@Req() request: LogoutRequest): Promise<LogoutResponse> {
    const principal = tokenPrincipal(request);
    // Unreachable behind stage ②; never answer 200 for a request no token check vouched for.
    if (principal === undefined)
      throw new Error('identity: logout without a verified access token');
    await this.logouts.logout(principal);
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }
}
