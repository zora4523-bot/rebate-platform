import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { LinkConvertService, type LinkConvertInput } from '../../application/link-convert.ts';

type ConvertLinkResponse = Schema<'ConvertLinkResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface ConvertLinkHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'ConvertLinkRequest'>;
}

function header(request: ConvertLinkHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `convertLink` (B1-06i; BR-PROD-03 / 11, BR-ATTR-08 / 14 / 27): x-auth login,
 * x-signed, x-idempotent. The body is passed as the contract validated it (installed defaults to
 * unknown); the client comes from the X-Platform header and the identity from the server-side
 * CallerContext inside the use case. Use-case errors keep their code and HTTP status.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax), as for the open.
 */
export class LinkConvertController {
  readonly #links: LinkConvertService;

  constructor(links: LinkConvertService) {
    this.#links = links;
  }

  async convert(request: ConvertLinkHttpRequest): Promise<ConvertLinkResponse> {
    const body = request.body;
    const result = await this.#links.convert({
      body: { ...body, installed: body.installed ?? 'unknown' },
      idempotencyKey: header(request, 'idempotency-key'),
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
      client: header(request, 'x-platform') as LinkConvertInput['client'],
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as ConvertLinkResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = LinkConvertController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'convert')!;
  Inject(LinkConvertService)(LinkConvertController, undefined, 0);
  Req()(prototype, 'convert', 0);
  Post('links/convert')(prototype, 'convert', descriptor);
  HttpCode(200)(prototype, 'convert', descriptor);
  RouteSchema(contractRouteSchema('convertLink'))(prototype, 'convert', descriptor);
  Controller('v1')(LinkConvertController);
}
