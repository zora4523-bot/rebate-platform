// POST /admin/v1/pages/{page_key}/preview-tokens (F1-09e; contract adminCreatePagePreviewToken):
// 04 §11.2 content.page 「草稿预览二维码」, no step-up. The admin request check has verified the
// admin_token and the contract's route schema has validated page_key and the body (20001) before
// the handler runs. The handler runs inside platform's AdminOperationGuard as a write (10403
// without the point, nothing read before); the app is the guard's actor, never a request field.
// The token is returned once in the response and never logged or audited.
// Served by the admin entry only (content's ContentAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  PagePreviewFieldsError,
  PagePreviewNotFoundError,
  PagePreviewService,
} from '../../application/page-preview.ts';

export interface PagePreviewTokensRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

const PERMISSION = 'content.page';

export class AdminPagePreviewTokensController {
  readonly #guard: AdminOperationGuard;
  readonly #previews: PagePreviewService;

  constructor(guard: AdminOperationGuard, previews: PagePreviewService) {
    this.#guard = guard;
    this.#previews = previews;
  }

  /** adminCreatePagePreviewToken. */
  async issue(
    request: PagePreviewTokensRequest,
    pageKey: string,
    body: Schema<'AdminPagePreviewTokenRequest'>,
  ): Promise<Schema<'AdminPagePreviewTokenResponse'>> {
    let response: Schema<'AdminPagePreviewTokenResponse'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await this.#previews.issue(
          {
            appId: actor.appId,
            adminId: actor.adminId,
            ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          },
          pageKey,
          body.version,
        );
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) {
      throw new Error('content: admin guard returned without the issue');
    }
    return response;
  }
}

/** 20001 (data.fields) and 30701 (no data); anything else is rethrown (50001). */
function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof PagePreviewFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof PagePreviewNotFoundError) {
    return new HttpException({ code: 30701, msg: '页面或内容不存在', trace_id: traceId }, 404);
  }
  return error;
}

{
  const prototype = AdminPagePreviewTokensController.prototype;
  const issue = Object.getOwnPropertyDescriptor(prototype, 'issue')!;
  Inject(AdminOperationGuard)(AdminPagePreviewTokensController, undefined, 0);
  Inject(PagePreviewService)(AdminPagePreviewTokensController, undefined, 1);
  Req()(prototype, 'issue', 0);
  Param('page_key')(prototype, 'issue', 1);
  Body()(prototype, 'issue', 2);
  Post(':page_key/preview-tokens')(prototype, 'issue', issue);
  HttpCode(200)(prototype, 'issue', issue);
  RouteSchema(contractRouteSchema('adminCreatePagePreviewToken'))(prototype, 'issue', issue);
  Controller('admin/v1/pages')(AdminPagePreviewTokensController);
}
