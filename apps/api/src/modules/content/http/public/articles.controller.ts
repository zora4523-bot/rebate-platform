import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  fieldsErrorEnvelope,
  type ContractOperationId,
} from '../../../platform/index.ts';
import { ArticleReader, type ArticleListQuery } from '../../application/article-reader.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';
import { ArticleCursorError, ArticleHelpSectionFilterError } from '../../domain/articles.ts';

interface ArticleRequest {
  readonly id: string;
}

/** Anonymous, unsigned api routes. Identity's request viewer supplies only the app scope here. */
export class ArticlesController {
  readonly #reader: ArticleReader;
  readonly #viewer: ConfigViewerContext;

  constructor(reader: ArticleReader, viewer: ConfigViewerContext) {
    this.#reader = reader;
    this.#viewer = viewer;
  }

  async list(
    request: ArticleRequest,
    query: ArticleListQuery,
  ): Promise<Schema<'ArticleListResponse'>> {
    const viewer = await this.#viewer.current();
    try {
      const data = await this.#reader.list(viewer.appId, query);
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof ArticleHelpSectionFilterError) {
        const refused = fieldsErrorEnvelope(['help_section'], request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      if (error instanceof ArticleCursorError) {
        const refused = fieldsErrorEnvelope(['cursor'], request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }

  async detail(
    request: ArticleRequest,
    id: string,
    query: { readonly version?: number },
  ): Promise<Schema<'ArticleResponse'>> {
    const viewer = await this.#viewer.current();
    const data = await this.#reader.detail(viewer.appId, id, query.version);
    if (data === null) {
      throw new HttpException(
        { code: 30701, msg: '页面或内容不存在', data: {}, trace_id: request.id },
        404,
      );
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

// Plain decorator calls keep the test project's erasable-syntax compilation compatible.
// The task's mechanical contract commit removes planned and regenerates these schemas before
// runtime verification. Missing schemas deliberately fail closed, never bypass validation.
{
  const prototype = ArticlesController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Inject(ArticleReader)(ArticlesController, undefined, 0);
  Inject(ConfigViewerContext)(ArticlesController, undefined, 1);
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Get()(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listArticles' as ContractOperationId))(prototype, 'list', list);
  Req()(prototype, 'detail', 0);
  Param('article_id')(prototype, 'detail', 1);
  Query()(prototype, 'detail', 2);
  Get(':article_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getArticle' as ContractOperationId))(
    prototype,
    'detail',
    detail,
  );
  Controller('v1/articles')(ArticlesController);
}
