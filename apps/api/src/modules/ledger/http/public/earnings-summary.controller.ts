// B2-13a: GET /v1/earnings/summary (contract getEarningsSummary: x-auth login, unsigned, not
// idempotent, error 30701). The subject is the request's token principal only (app_id, uid →
// userId), never X-App-Id, the query or the path (BR-AI-03); the optional platform query (enum
// PlatformCode, validated by the contract route schema: unknown → 20001) only filters self and
// share. No principal → 401 / 10001 without calling the query; earnings.dashboard.enabled off →
// 404 / 30701 with no figures. Plain decorator calls like the wallet summary controller.
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  tokenPrincipal,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { EarningsSummaryQuery } from '../../application/earnings-summary.ts';

/** Nest token of the earnings summary query bound to the entry's database handle. */
export const EARNINGS_SUMMARY_QUERY = Symbol('EARNINGS_SUMMARY_QUERY');

export interface EarningsSummaryHttpRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
  readonly query?: { readonly platform?: Schema<'PlatformCode'> };
}

export class EarningsSummaryController {
  readonly #query: EarningsSummaryQuery;

  constructor(query: EarningsSummaryQuery) {
    this.#query = query;
  }

  async summary(request: EarningsSummaryHttpRequest): Promise<Schema<'EarningsSummaryResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    const result = await this.#query({
      appId: principal.app_id,
      userId: principal.uid,
      platform: request.query?.platform ?? null,
    });
    if (!result.enabled) {
      throw new HttpException({ code: 30701, msg: '页面或内容不存在', trace_id: request.id }, 404);
    }
    return { code: 0, msg: '', trace_id: request.id, data: result.data };
  }
}

Controller('v1')(EarningsSummaryController);
Inject(EARNINGS_SUMMARY_QUERY)(EarningsSummaryController, undefined, 0);
{
  const prototype = EarningsSummaryController.prototype;
  const summaryMethod = Object.getOwnPropertyDescriptor(prototype, 'summary')!;
  Get('earnings/summary')(prototype, 'summary', summaryMethod);
  RouteSchema(contractRouteSchema('getEarningsSummary'))(prototype, 'summary', summaryMethod);
  Req()(prototype, 'summary', 0);
}
