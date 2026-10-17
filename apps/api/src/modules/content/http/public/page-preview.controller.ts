// GET /v1/pages/{page_key}/preview (F1-09e; contract previewPage, x-auth none, unsigned): only an
// admin-issued preview token opens a version (04 §6.2). The route schema has validated page_key
// and the token query (missing or longer than 256 → 20001) and the request check has validated
// X-App-Id, the app scope of the read. Authorization is never read: a user token neither
// replaces nor changes a preview. Every refusal is the same 30701 envelope, without data.
// Served by the api entry only (content's ContentPublicModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax).
import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { PagePreviewNotFoundError, PagePreviewService } from '../../application/page-preview.ts';

interface PagePreviewRequest {
  readonly id: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

export class PagePreviewController {
  readonly #previews: PagePreviewService;

  constructor(previews: PagePreviewService) {
    this.#previews = previews;
  }

  /** previewPage. */
  async preview(
    request: PagePreviewRequest,
    pageKey: string,
    query: { readonly token: string },
  ): Promise<Schema<'PagePreviewResponse'>> {
    const appId = request.headers['x-app-id'];
    if (typeof appId !== 'string' || appId === '') {
      throw new Error('content: preview request carries no app scope');
    }
    try {
      const data = await this.#previews.read(appId, pageKey, query.token);
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof PagePreviewNotFoundError) {
        throw new HttpException(
          { code: 30701, msg: '页面或内容不存在', trace_id: request.id },
          404,
        );
      }
      throw error;
    }
  }
}

{
  const prototype = PagePreviewController.prototype;
  const preview = Object.getOwnPropertyDescriptor(prototype, 'preview')!;
  Inject(PagePreviewService)(PagePreviewController, undefined, 0);
  Req()(prototype, 'preview', 0);
  Param('page_key')(prototype, 'preview', 1);
  Query()(prototype, 'preview', 2);
  Get(':page_key/preview')(prototype, 'preview', preview);
  RouteSchema(contractRouteSchema('previewPage'))(prototype, 'preview', preview);
  Controller('v1/pages')(PagePreviewController);
}
