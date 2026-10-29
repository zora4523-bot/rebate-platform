import { Controller, Get, HttpException, Inject, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { CatalogHotRankService } from '../../application/hot-rank-service.ts';
import { CatalogError } from '../../domain/rules.ts';
import type { HotRankQuery } from '../../hot-rank.ts';

type HotRankResponse = Schema<'HotRankResponse'>;

interface TracedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

/**
 * Fallback texts (`msg`); clients show their dictionary text error.<code>[.<reason>]
 * (contracts/texts.default.json, BR-TEXT-14).
 */
const MESSAGES = Object.freeze({
  20001: '填写内容有误，请检查',
  50304: '榜单暂不可用，请稍后再试',
});

/** Statuses of contracts/error-codes.yaml for the codes getHotRank can fail with. */
const STATUS: Readonly<Record<number, number>> = { 20001: 400, 50304: 503 };

/** The query field a 20001 of the use case concerns (its messages name the parameter). */
function fieldsOf(message: string): string[] {
  if (message.includes('cursor')) return ['cursor'];
  if (message.includes('category')) return ['category'];
  return ['query'];
}

/** The error envelope of a CatalogError; undefined for any other failure (global filter, 50001). */
function errorResponse(error: unknown, traceId: string): HttpException | undefined {
  if (!(error instanceof CatalogError)) return undefined;
  const status = STATUS[error.code];
  if (status === undefined) return undefined;
  const msg = MESSAGES[error.code as 20001 | 50304];
  // 20001: data.fields; 50304: data.platform plus reason=rank_unavailable when no channel is
  // compliant (a union failure carries no reason); never the cause.
  const data = error.code === 20001 ? { fields: fieldsOf(error.message) } : { ...error.data };
  return new HttpException({ code: error.code, msg, data, trace_id: traceId }, status);
}

/**
 * Contract operation `getHotRank` (CT-22c; 规划/01 F-PROD-13; BR-TEXT-13, BR-TEXT-17): x-auth none;
 * the viewer is the request's guest (or identity's viewer on the `api` entry). The route schema
 * has validated the query; the use case owns every business check.
 * Nest metadata is applied below without decorator syntax: rule tests import CatalogModule, and
 * their TypeScript project accepts erasable syntax only.
 */
export class HotRankController {
  readonly #service: CatalogHotRankService;

  constructor(service: CatalogHotRankService) {
    this.#service = service;
  }

  async hot(request: TracedRequest, query: HotRankQuery): Promise<HotRankResponse> {
    try {
      const data = await this.#service.hot(query);
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error: unknown) {
      throw errorResponse(error, request.id) ?? error;
    }
  }
}

Controller('v1')(HotRankController);
Inject(CatalogHotRankService)(HotRankController, undefined, 0);
const hotMethod = Object.getOwnPropertyDescriptor(HotRankController.prototype, 'hot')!;
Get('rank/hot')(HotRankController.prototype, 'hot', hotMethod);
RouteSchema(contractRouteSchema('getHotRank'))(HotRankController.prototype, 'hot', hotMethod);
Req()(HotRankController.prototype, 'hot', 0);
Query()(HotRankController.prototype, 'hot', 1);
