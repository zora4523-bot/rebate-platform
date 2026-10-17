import { Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { MeService } from '../../application/me.ts';
import type { UpdateNicknameService } from '../../application/update-nickname.ts';
import { ME, UPDATE_NICKNAME } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

@Controller('v1')
export class MeController {
  constructor(
    @Inject(ME) private readonly me: MeService | null,
    @Inject(UPDATE_NICKNAME) private readonly nickname: UpdateNicknameService | null,
  ) {}

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

  @Patch('me')
  @RouteSchema(contractRouteSchema('updateMe'))
  async updateMe(
    @Req()
    request: CheckedRequest & { readonly id: string; readonly body: Schema<'UpdateMeRequest'> },
  ): Promise<Schema<'EmptyResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.nickname === null) throw new Error('identity: nickname update needs the database');
    const result = await this.nickname.update({
      appId: principal.app_id,
      userId: principal.uid,
      nickname: request.body.nickname,
    });
    if (result.code !== 0) throw identityFailure(result, request.id);
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }
}
