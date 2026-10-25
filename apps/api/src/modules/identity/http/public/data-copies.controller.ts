import { Controller, Get, HttpException, Inject, Param, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  MY_DATA_COPIES,
  type MyDataCopies,
  type MyDataCopySubject,
} from '../../application/my-data-copies.ts';
import { identityFailure } from './error-envelopes.ts';

interface DataCopiesRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** contracts/texts.default.json error.30701 (clients show their own dictionary text). */
const MSG_30701 = '内容不存在或已下线';

/**
 * The App page DataCopy (B1-27i; BR-ID-40 细则「在 App 内下载」; contract listMyDataCopies /
 * getMyDataCopyDownload). x-auth login: the subject is the token's app_id and uid only. Login
 * (10001), the 10006 whitelist and the deletion_only scope are the global request checks; every
 * refusal of a download is the same 30701 (HTTP 404). The download answers Cache-Control: no-store.
 */
@Controller('v1')
export class DataCopiesController {
  constructor(@Inject(MY_DATA_COPIES) private readonly copies: MyDataCopies | null) {}

  @Get('me/data-copies')
  @RouteSchema(contractRouteSchema('listMyDataCopies'))
  async list(@Req() request: DataCopiesRequest): Promise<Schema<'DataCopyListResponse'>> {
    const { copies, subject } = this.prepare(request);
    const items = await copies.list(subject);
    return {
      code: 0,
      msg: '',
      data: {
        items: items.map((item) => ({
          copy_id: item.copyId,
          status: item.status,
          generated_at: item.generatedAt.toISOString(),
          expires_at: item.expiresAt.toISOString(),
        })),
      },
      trace_id: request.id,
    };
  }

  @Get('me/data-copies/:id/download')
  @RouteSchema(contractRouteSchema('getMyDataCopyDownload'))
  async download(
    @Req() request: DataCopiesRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<Schema<'DataCopyDownloadResponse'>> {
    reply.header('Cache-Control', 'no-store');
    const { copies, subject } = this.prepare(request);
    const result = await copies.download(subject, id);
    if (result.kind !== 'link') {
      throw new HttpException({ code: 30701, msg: MSG_30701, trace_id: request.id }, 404);
    }
    return {
      code: 0,
      msg: '',
      data: { url: result.url, url_expires_at: result.urlExpiresAt.toISOString() },
      trace_id: request.id,
    };
  }

  private prepare(request: DataCopiesRequest): {
    copies: MyDataCopies;
    subject: MyDataCopySubject;
  } {
    const principal = tokenPrincipal(request);
    // Stage ② has already refused a guest (x-auth login); never answer without a subject.
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.copies === null) throw new Error('identity: data copies need the database');
    return { copies: this.copies, subject: { appId: principal.app_id, userId: principal.uid } };
  }
}
