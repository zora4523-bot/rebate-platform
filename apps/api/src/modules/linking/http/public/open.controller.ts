import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { LinkOpenService } from '../../application/link-open.ts';
import type { LinkOpenRequoteInput } from '../../application/link-open-requote.ts';

type OpenLinkResponse = Schema<'OpenLinkResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface OpenLinkHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params: { readonly link_id: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'OpenLinkRequest'>;
}

function header(request: OpenLinkHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `openLink` (BR-PRICE-13, BR-ATTR-05/27, BR-ID-18): x-auth optional,
 * x-signed, x-idempotent. The client comes from the X-Platform header, never the body; the
 * identity comes from the server-side CallerContext inside the use case. Use-case errors keep
 * their code and HTTP status.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax): linking's index is
 * reachable from the test project, whose compiler settings have no legacy decorators.
 */
export class LinkOpenController {
  readonly #links: LinkOpenService;

  constructor(links: LinkOpenService) {
    this.#links = links;
  }

  async open(request: OpenLinkHttpRequest): Promise<OpenLinkResponse> {
    const body = request.body;
    const result = await this.#links.open({
      linkId: request.params.link_id,
      idempotencyKey: header(request, 'idempotency-key'),
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
      client: header(request, 'x-platform') as LinkOpenRequoteInput['client'],
      installed: body.installed ?? 'unknown',
      noRebate: body.no_rebate ?? false,
      ...(body.no_rebate_reason === undefined ? {} : { noRebateReason: body.no_rebate_reason }),
      ...(body.spm === undefined ? {} : { spm: body.spm }),
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as OpenLinkResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = LinkOpenController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'open')!;
  Inject(LinkOpenService)(LinkOpenController, undefined, 0);
  Req()(prototype, 'open', 0);
  Post('links/:link_id/open')(prototype, 'open', descriptor);
  HttpCode(200)(prototype, 'open', descriptor);
  RouteSchema(contractRouteSchema('openLink'))(prototype, 'open', descriptor);
  Controller('v1')(LinkOpenController);
}
