import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { CatalogSectionItemsService } from '../../application/section-items-service.ts';
import { CatalogError } from '../../domain/rules.ts';

type PageSectionItemsResponse = Schema<'PageSectionItemsResponse'>;

interface TracedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

/**
 * Fallback texts (`msg`); clients show their dictionary text error.<code>
 * (contracts/texts.default.json, BR-TEXT-14).
 */
const MESSAGES = Object.freeze({
  20001: '填写内容有误，请检查',
  30701: '页面或内容不存在',
});

/** Statuses of contracts/error-codes.yaml for the codes listPageSectionItems can fail with. */
const STATUS: Readonly<Record<number, number>> = { 20001: 400, 30701: 404 };

/** The error envelope of a CatalogError; undefined for any other failure (global filter, 50001). */
function errorResponse(error: unknown, traceId: string): HttpException | undefined {
  if (!(error instanceof CatalogError)) return undefined;
  const status = STATUS[error.code];
  if (status === undefined) return undefined;
  const msg = MESSAGES[error.code as 20001 | 30701];
  return new HttpException(
    { code: error.code, msg, data: { ...error.data }, trace_id: traceId },
    status,
  );
}

/**
 * Contract operation `listPageSectionItems` (CT-07c; BR-TEXT-17 细则「联盟物料频道」): x-auth optional;
 * the viewer is identity's on the `api` entry. The route schema has validated the path and query
 * shapes (20001 fields=[page_key] / [section_id]); the use case owns every business check.
 * Nest metadata is applied below without decorator syntax: rule tests import CatalogModule, and
 * their TypeScript project accepts erasable syntax only.
 */
export class SectionItemsController {
  readonly #service: CatalogSectionItemsService;

  constructor(service: CatalogSectionItemsService) {
    this.#service = service;
  }

  async items(
    request: TracedRequest,
    pageKey: string,
    sectionId: string,
    query: { readonly cursor?: string },
  ): Promise<PageSectionItemsResponse> {
    try {
      const data = await this.#service.items({
        pageKey,
        sectionId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error: unknown) {
      throw errorResponse(error, request.id) ?? error;
    }
  }
}

Controller('v1')(SectionItemsController);
Inject(CatalogSectionItemsService)(SectionItemsController, undefined, 0);
const itemsMethod = Object.getOwnPropertyDescriptor(SectionItemsController.prototype, 'items')!;
Get('pages/:page_key/sections/:section_id/items')(
  SectionItemsController.prototype,
  'items',
  itemsMethod,
);
RouteSchema(contractRouteSchema('listPageSectionItems'))(
  SectionItemsController.prototype,
  'items',
  itemsMethod,
);
Req()(SectionItemsController.prototype, 'items', 0);
Param('page_key')(SectionItemsController.prototype, 'items', 1);
Param('section_id')(SectionItemsController.prototype, 'items', 2);
Query()(SectionItemsController.prototype, 'items', 3);
