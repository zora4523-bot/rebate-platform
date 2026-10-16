import { Controller, Delete, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { TipSubject, TipsService } from '../../application/tips.ts';
import { TIPS } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

/** What these handlers read of the Fastify request, already checked by stages ② ③ and the schema. */
interface TipsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params?: { readonly tip_key?: string };
  readonly body?: unknown;
}

/**
 * One-time tips (B1-02s; 规划/04 §6.1; BR-ATTR-21, BR-INV-03 细则). x-auth login: the subject is
 * the token's app_id and uid only. Login (10001), the version gate of the two writes (10405), ban
 * and rate limits are the global request checks the contract applies to these routes.
 * The first parameter of every handler is the Fastify request taken with @Req() (the frozen risk
 * tests swap markTipRead's function and rely on it).
 */
@Controller('v1')
export class TipsController {
  constructor(@Inject(TIPS) private readonly tips: TipsService | null) {}

  /** Contract operation `getTips`: read only, not version gated. */
  @Get('me/tips')
  @RouteSchema(contractRouteSchema('getTips'))
  async getTips(@Req() request: TipsRequest): Promise<Schema<'TipsResponse'>> {
    const { tips, subject } = this.prepare(request);
    return { code: 0, msg: '', data: await tips.read(subject), trace_id: request.id };
  }

  /**
   * Contract operation `markTipRead`. The route schema checks the path (TipKey) and headers only:
   * the body is optional in the contract (inviter_before_buy sends none), so jump_tip's
   * MarkTipReadRequest is checked by the use case (20001 with data.fields).
   */
  @Post('me/tips/:tip_key/read')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('markTipRead'))
  async markTipRead(@Req() request: TipsRequest): Promise<Schema<'EmptyResponse'>> {
    const { tips, subject } = this.prepare(request);
    const tipKey = request.params?.tip_key;
    if (tipKey !== 'jump_tip' && tipKey !== 'inviter_before_buy') {
      throw identityFailure({ code: 20001, data: { fields: ['tip_key'] } }, request.id);
    }
    const result = await tips.markRead(subject, tipKey, request.body);
    if (result.code !== 0) throw identityFailure(result, request.id);
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }

  /** Contract operation `resetTip`: only jump_tip (ResettableTipKey), every platform. */
  @Delete('me/tips/:tip_key')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('resetTip'))
  async resetTip(@Req() request: TipsRequest): Promise<Schema<'EmptyResponse'>> {
    const { tips, subject } = this.prepare(request);
    if (request.params?.tip_key !== 'jump_tip') {
      throw identityFailure({ code: 20001, data: { fields: ['tip_key'] } }, request.id);
    }
    await tips.resetJumpTip(subject);
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }

  private prepare(request: TipsRequest): { tips: TipsService; subject: TipSubject } {
    const principal = tokenPrincipal(request);
    // Stage ② has already refused a guest (x-auth login); never answer without a subject.
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.tips === null) throw new Error('identity: tips need the database');
    return { tips: this.tips, subject: { app_id: principal.app_id, user_id: principal.uid } };
  }
}
