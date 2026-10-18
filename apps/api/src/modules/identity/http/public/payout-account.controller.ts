// GET /v1/me/payout-account (getPayoutAccount; 规划/04 §6.1; 08 BR-WDR-02 ④, BR-ID-33; task B1-13e).
// Contract: x-auth realname, not signed, not idempotent. Before the handler, guard stage ⑨ answers
// 30304 to a member without a verified real name (B1-02za), and the token check refuses an h5_token
// with 10403 (H5_EXCLUDED_PREFIXES). The handler returns only the masked projection of
// application/payout-account.ts ({} when nothing is bound). PUT stays planned (B1-13f).
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { PayoutAccountReader } from '../../application/payout-account.ts';
import { PAYOUT_ACCOUNT_READER } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

@Controller('v1')
export class PayoutAccountController {
  constructor(@Inject(PAYOUT_ACCOUNT_READER) private readonly reader: PayoutAccountReader | null) {}

  @Get('me/payout-account')
  @RouteSchema(contractRouteSchema('getPayoutAccount'))
  async getPayoutAccount(
    @Req() request: CheckedRequest & { readonly id: string },
  ): Promise<Schema<'PayoutAccountResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.reader === null) {
      throw new Error('identity: payout account needs the database and the field cipher');
    }
    const data = await this.reader.read({ appId: principal.app_id, userId: principal.uid });
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}
