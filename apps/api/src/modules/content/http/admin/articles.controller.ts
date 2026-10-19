// /admin/v1/articles* (F1-02w; contract adminListArticles, adminGetArticle, adminCreateArticle,
// adminSaveArticleDraft, adminPublishArticle, adminOfflineArticle). 04 §11.2 content.article, step-up
// 「–」: the two reads pass `readOnly: true`, the four writes need the point only. The contract's
// route schema has validated the query and the body (20001) before a handler runs; each handler
// runs inside platform's AdminOperationGuard, so no article is read before the permission passes;
// the app and admin are the guard's actor, never request fields. Served by the admin entry only
// (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// agreements.controller.ts.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  ArticleAdmin,
  ArticleConflictError,
  ArticleFieldsError,
  ArticleNotFoundError,
  type ArticleAdminActor,
  type ArticleAdminQuery,
} from '../../application/article-admin.ts';

export interface ArticleAdminRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

const PERMISSION = 'content.article';

export class AdminArticlesController {
  readonly #guard: AdminOperationGuard;
  readonly #articles: ArticleAdmin;

  constructor(guard: AdminOperationGuard, articles: ArticleAdmin) {
    this.#guard = guard;
    this.#articles = articles;
  }

  /** adminListArticles. */
  list(
    request: ArticleAdminRequest,
    query: ArticleAdminQuery,
  ): Promise<Envelope<Schema<'AdminArticleList'>>> {
    return this.#run(request, true, (actor) => this.#articles.list(actor.appId, query ?? {}));
  }

  /** adminGetArticle. */
  detail(
    request: ArticleAdminRequest,
    articleId: string,
  ): Promise<Envelope<Schema<'AdminArticle'>>> {
    return this.#run(request, true, (actor) => this.#articles.detail(actor.appId, articleId));
  }

  /** adminCreateArticle. */
  create(
    request: ArticleAdminRequest,
    body: Schema<'AdminArticleCreateRequest'>,
  ): Promise<Envelope<Schema<'AdminArticle'>>> {
    return this.#run(request, false, (actor) =>
      this.#articles.create(writerOf(actor, request), body),
    );
  }

  /** adminSaveArticleDraft. */
  save(
    request: ArticleAdminRequest,
    articleId: string,
    body: Schema<'AdminArticleDraftRequest'>,
  ): Promise<Envelope<Schema<'AdminArticle'>>> {
    return this.#run(request, false, (actor) =>
      this.#articles.save(writerOf(actor, request), articleId, body),
    );
  }

  /** adminPublishArticle. */
  publish(
    request: ArticleAdminRequest,
    articleId: string,
    body: Schema<'AdminArticlePublishRequest'>,
  ): Promise<Envelope<Schema<'AdminArticle'>>> {
    return this.#run(request, false, (actor) =>
      this.#articles.publish(writerOf(actor, request), articleId, body),
    );
  }

  /** adminOfflineArticle. */
  offline(
    request: ArticleAdminRequest,
    articleId: string,
    body: Schema<'AdminArticleOfflineRequest'>,
  ): Promise<Envelope<Schema<'AdminArticle'>>> {
    return this.#run(request, false, (actor) =>
      this.#articles.offline(writerOf(actor, request), articleId, body),
    );
  }

  async #run<T>(
    request: ArticleAdminRequest,
    readOnly: boolean,
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run(
      readOnly
        ? { request, permission: PERMISSION, readOnly: true }
        : { request, permission: PERMISSION },
      async (actor) => {
        try {
          const data = await work(actor);
          response = { code: 0, msg: '', data, trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          throw refusal(error, request.id);
        }
      },
    );
    if (response === undefined) throw new Error('content: admin guard returned without the call');
    return response;
  }
}

/** The guard's verified actor; the request contributes only its address for the audit row. */
function writerOf(actor: AdminActor, request: ArticleAdminRequest): ArticleAdminActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

/** 20001 (data.fields), 20902 (data.resource=article), 30701; anything else rethrown (50001). */
export function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof ArticleFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof ArticleConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'article' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof ArticleNotFoundError) {
    return new HttpException({ code: 30701, msg: '内容不存在', trace_id: traceId }, 404);
  }
  return error;
}

{
  const prototype = AdminArticlesController.prototype;
  const routes = [
    ['list', 'Get', '', 'adminListArticles', ['query']],
    ['create', 'Post', '', 'adminCreateArticle', ['body']],
    ['detail', 'Get', ':article_id', 'adminGetArticle', ['article_id']],
    ['save', 'Put', ':article_id/draft', 'adminSaveArticleDraft', ['article_id', 'body']],
    ['publish', 'Post', ':article_id/publish', 'adminPublishArticle', ['article_id', 'body']],
    ['offline', 'Post', ':article_id/offline', 'adminOfflineArticle', ['article_id', 'body']],
  ] as const;
  Inject(AdminOperationGuard)(AdminArticlesController, undefined, 0);
  Inject(ArticleAdmin)(AdminArticlesController, undefined, 1);
  for (const [name, method, path, operationId, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    args.forEach((arg, index) => {
      if (arg === 'query') Query()(prototype, name, index + 1);
      else if (arg === 'body') Body()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    (method === 'Get' ? Get(path) : method === 'Put' ? Put(path) : Post(path))(
      prototype,
      name,
      descriptor,
    );
    if (method === 'Post') HttpCode(200)(prototype, name, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, descriptor);
  }
  Controller('admin/v1/articles')(AdminArticlesController);
}
