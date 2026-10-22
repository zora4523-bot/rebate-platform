// B2-04y: GET /v1/wallet/summary (contract getWalletSummary: x-auth login, unsigned, not
// idempotent; full and deletion_only sessions). The subject is the request's token principal only
// (app_id, uid → userId), never X-App-Id, the query, the body or the path (BR-AI-03). The answer's
// data is exactly what the query (ledger/read.ts's getWalletSummary) returned. No principal → 401
// / 10001 without calling the query. Plain decorator calls like notification's controllers.
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  tokenPrincipal,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { WalletSummaryQuery } from '../../application/wallet-summary.ts';

/** Nest token of the wallet summary query bound to the entry's database handle. */
export const WALLET_SUMMARY_QUERY = Symbol('WALLET_SUMMARY_QUERY');

export interface WalletSummaryRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
}

export class WalletSummaryController {
  readonly #query: WalletSummaryQuery;

  constructor(query: WalletSummaryQuery) {
    this.#query = query;
  }

  async summary(request: WalletSummaryRequest): Promise<Schema<'WalletSummaryResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    const data = await this.#query({ appId: principal.app_id, userId: principal.uid });
    return { code: 0, msg: '', trace_id: request.id, data };
  }
}

Controller('v1')(WalletSummaryController);
Inject(WALLET_SUMMARY_QUERY)(WalletSummaryController, undefined, 0);
{
  const prototype = WalletSummaryController.prototype;
  const summaryMethod = Object.getOwnPropertyDescriptor(prototype, 'summary')!;
  Get('wallet/summary')(prototype, 'summary', summaryMethod);
  RouteSchema(contractRouteSchema('getWalletSummary'))(prototype, 'summary', summaryMethod);
  Req()(prototype, 'summary', 0);
}
