// GET /v1/pages/{page_key} (task F1-09d; contract getPage: x-auth optional, unsigned, session
// scope full only). The request checks have already verified any bearer token; the caller comes
// from the request-scoped ConfigViewerContext (identity's, assembled by app.module) and only
// decides `loggedIn`. The X-Device-Id header is read only to bucket the gray rollout, never as an
// identity; X-Platform and X-App-Version only gate sections. The page_key shape is checked by the
// contract route schema (20001 fields=[page_key]) before this handler runs.
//
// Nest's decorators are applied as plain calls below (not decorator syntax): content's index.ts
// is reachable from the test project, whose compiler settings have no legacy decorators.
import { Controller, Get, HttpException, Inject, Param, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type ContractOperationId } from '../../../platform/index.ts';
import { ConfigViewerContext } from '../../application/client-config.ts';
import { PageReader } from '../../application/page-reader.ts';

export interface PageRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function header(request: PageRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class PagesController {
  readonly #reader: PageReader;
  readonly #viewer: ConfigViewerContext;

  constructor(reader: PageReader, viewer: ConfigViewerContext) {
    this.#reader = reader;
    this.#viewer = viewer;
  }

  async read(request: PageRequest, pageKey: string): Promise<Schema<'PageResponse'>> {
    const viewer = await this.#viewer.current();
    const device = header(request, 'x-device-id');
    const data = await this.#reader.read(
      viewer.appId,
      pageKey,
      device === undefined || device === '' ? null : device,
      {
        loggedIn: viewer.userId !== null,
        platform: header(request, 'x-platform') ?? '',
        appVersion: header(request, 'x-app-version'),
      },
    );
    if (data === null) {
      throw new HttpException(
        { code: 30701, msg: '页面或内容不存在', data: {}, trace_id: request.id },
        404,
      );
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

{
  const prototype = PagesController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(PageReader)(PagesController, undefined, 0);
  Inject(ConfigViewerContext)(PagesController, undefined, 1);
  Req()(prototype, 'read', 0);
  Param('page_key')(prototype, 'read', 1);
  Get(':page_key')(prototype, 'read', read);
  RouteSchema(contractRouteSchema('getPage' as ContractOperationId))(prototype, 'read', read);
  Controller('v1/pages')(PagesController);
}
