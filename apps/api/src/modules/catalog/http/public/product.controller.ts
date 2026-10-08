import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { CatalogDetailService } from '../../application/detail-service.ts';
import { CatalogError } from '../../domain/rules.ts';

type ProductResponse = Schema<'ProductResponse'>;

interface TracedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

/** Query of the contract operation getProduct (the route schema rejects any other field). */
interface ProductQuery {
  readonly item_ref?: string;
}

/**
 * Fallback texts (`msg`); clients show their dictionary text error.<code>
 * (contracts/texts.default.json, BR-TEXT-14).
 */
const MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  20001: '填写内容有误，请检查',
  30131: '暂不支持这个链接或平台',
  30141: '商品已下架',
  30143: '商品信息已失效，请重新搜索',
  50303: '暂时无法确认价格，请稍后再试',
  50401: '出了点问题，请稍后再试',
});

/** Statuses of contracts/error-codes.yaml for the codes getProduct can fail with. */
const STATUS: Readonly<Record<number, number>> = {
  20001: 400,
  30131: 422,
  30141: 422,
  30143: 422,
  50303: 503,
  50401: 504,
};

/** The error envelope of a CatalogError; undefined for any other failure (global filter, 50001). */
function errorResponse(error: unknown, traceId: string): HttpException | undefined {
  if (!(error instanceof CatalogError)) return undefined;
  const status = STATUS[error.code];
  const msg = MESSAGES[error.code];
  if (status === undefined || msg === undefined) return undefined;
  // 20001 names the parameter: a token naming another product, or a malformed key.
  const data =
    error.code === 20001
      ? { fields: [error.message.includes('item_ref') ? 'item_ref' : 'product_key'] }
      : undefined;
  return new HttpException(
    { code: error.code, msg, ...(data === undefined ? {} : { data }), trace_id: traceId },
    status,
  );
}

/**
 * Contract operation `getProduct` (BR-PROD-03 / 05 / 11, BR-PRICE-05 / 11 / 12 / 14): x-auth
 * optional; the viewer comes from the request-scoped ViewerContext (a guest until identity is
 * wired). The route schema has validated the path and query; the use case owns every business
 * check. The contract has no source-link parameter, so a detail opened over HTTP has no source
 * card and quotes by BR-PRICE-07's risk row.
 * Nest metadata is applied below without decorator syntax (same as SearchController).
 */
export class ProductController {
  readonly #service: CatalogDetailService;

  constructor(service: CatalogDetailService) {
    this.#service = service;
  }

  async get(
    request: TracedRequest,
    productKey: string,
    query: ProductQuery,
  ): Promise<ProductResponse> {
    try {
      const data = await this.#service.get({
        product_key: productKey,
        ...(query.item_ref === undefined ? {} : { item_ref: query.item_ref }),
      });
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error: unknown) {
      throw errorResponse(error, request.id) ?? error;
    }
  }
}

Controller('v1')(ProductController);
Inject(CatalogDetailService)(ProductController, undefined, 0);
const getMethod = Object.getOwnPropertyDescriptor(ProductController.prototype, 'get')!;
Get('products/:product_key')(ProductController.prototype, 'get', getMethod);
RouteSchema(contractRouteSchema('getProduct'))(ProductController.prototype, 'get', getMethod);
Req()(ProductController.prototype, 'get', 0);
Param('product_key')(ProductController.prototype, 'get', 1);
Query()(ProductController.prototype, 'get', 2);
