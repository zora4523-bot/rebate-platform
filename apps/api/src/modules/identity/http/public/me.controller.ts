import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { MeService } from '../../application/me.ts';
import { ME } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

@Controller('v1')
export class MeController {
  constructor(@Inject(ME) private readonly me: MeService | null) {}

  @Get('me')
  @RouteSchema(contractRouteSchema('getMe'))
  async getMe(
    @Req() request: CheckedRequest & { readonly id: string },
  ): Promise<Schema<'MeResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.me === null) throw new Error('identity: me needs the database and read ports');
    const data = await this.me.read({ appId: principal.app_id, userId: principal.uid });
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}
