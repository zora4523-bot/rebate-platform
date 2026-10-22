// B2-05c: GET /v1/withdrawals/rules (getWithdrawRules; 规划/04 §6.4; 08 BR-WDR-03 细则「rules 接口」,
// BR-WDR-04 细则「提现页的金额输入」). x-auth login, unsigned, not idempotent, no version gate: the
// request checks have judged the token (h5_token is refused before the handler, H5_EXCLUDED_PREFIXES)
// and contractRouteSchema the query (amount_fen a positive integer or 20001 data.fields). The
// subject is the token principal only (app_id, uid, device_id; BR-AI-03), never a header or a
// query value. The handler calls the rules use case on the process handle and returns the
// contract envelope; a blocked withdrawal is a successful response (code 0) with can_withdraw
// false, never an error envelope.
//
// Nest's decorators are applied as plain calls (erasable syntax, as the orders module does).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { Controller, Get, HttpException, Inject, Optional, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Kysely } from 'kysely';
import {
  contractRouteSchema,
  tokenPrincipal,
  type TokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { WithdrawActor, WithdrawRulesService } from '../../application/withdraw-rules.ts';
import { WITHDRAW_RULES, WITHDRAW_RULES_HANDLE } from '../../tokens.ts';

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface WithdrawRulesHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly query?: { readonly amount_fen?: number | string };
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export interface CreateWithdrawalHttpRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'CreateWithdrawalRequest'>;
}

export interface WithdrawalRawReply {
  code(status: number): WithdrawalRawReply;
  type(contentType: string): WithdrawalRawReply;
  send(body: string): unknown;
}

export class WithdrawalsController {
  readonly #service: WithdrawRulesService | null;
  readonly #handle: Kysely<DB> | null;

  constructor(service: WithdrawRulesService | null, handle: Kysely<DB> | null) {
    this.#service = service;
    this.#handle = handle;
  }

  async createWithdrawal(
    request: CreateWithdrawalHttpRequest,
    reply: WithdrawalRawReply,
  ): Promise<void> {
    void request;
    void reply;
    throw new Error('NotImplemented: createWithdrawal');
  }

  async getWithdrawRules(
    request: WithdrawRulesHttpRequest,
  ): Promise<Schema<'WithdrawRulesResponse'>> {
    const actor = this.#actor(request);
    const service = this.#service;
    const handle = this.#handle;
    if (service === null || handle === null) {
      throw new Error('payout: the withdrawal rules need the database');
    }
    const raw = request.query?.amount_fen;
    const amount = raw === undefined ? undefined : BigInt(raw);
    const data = await service.getRules(handle, actor, amount);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  #actor(request: WithdrawRulesHttpRequest): WithdrawActor {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { appId: principal.app_id, userId: principal.uid, deviceId: principal.device_id };
  }
}

{
  const prototype = WithdrawalsController.prototype;
  const rules = Object.getOwnPropertyDescriptor(prototype, 'getWithdrawRules')!;
  Inject(WITHDRAW_RULES)(WithdrawalsController, undefined, 0);
  Optional()(WithdrawalsController, undefined, 1);
  Inject(WITHDRAW_RULES_HANDLE)(WithdrawalsController, undefined, 1);
  Req()(prototype, 'getWithdrawRules', 0);
  Get('rules')(prototype, 'getWithdrawRules', rules);
  RouteSchema(contractRouteSchema('getWithdrawRules'))(prototype, 'getWithdrawRules', rules);
  Controller('v1/withdrawals')(WithdrawalsController);
}
