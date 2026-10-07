import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { LinkLandingService } from '../../application/link-landing.ts';

type LinkLandingResponse = Schema<'LinkLandingResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface LinkLandingHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params: { readonly link_id: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function header(request: LinkLandingHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `getLink` (B1-06j; BR-ATTR-05 细则「App 内打开链接的入口」, BR-ATTR-10/11,
 * BR-PRICE-06): x-auth optional, not signed, not idempotent, read-only. The identity comes from
 * the server-side CallerContext inside the use case; 30144 keeps its code and HTTP status.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax), as in the open's
 * controller: linking's index is reachable from the test project without legacy decorators.
 */
export class LinkLandingController {
  readonly #landing: LinkLandingService;

  constructor(landing: LinkLandingService) {
    this.#landing = landing;
  }

  async get(request: LinkLandingHttpRequest): Promise<LinkLandingResponse> {
    const result = await this.#landing.get({
      linkId: request.params.link_id,
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as LinkLandingResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = LinkLandingController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Inject(LinkLandingService)(LinkLandingController, undefined, 0);
  Req()(prototype, 'get', 0);
  Get('links/:link_id')(prototype, 'get', descriptor);
  RouteSchema(contractRouteSchema('getLink'))(prototype, 'get', descriptor);
  Controller('v1')(LinkLandingController);
}
