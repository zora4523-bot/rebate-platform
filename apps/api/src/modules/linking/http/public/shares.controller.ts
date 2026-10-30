import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { SharesService, type CreateShareInput } from '../../application/shares.ts';

type CreateShareResponse = Schema<'CreateShareResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface CreateShareHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'CreateShareRequest'>;
}

function header(request: CreateShareHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `createShare` (B1-15w; BR-ATTR-10 细则「分享页与分享赚入口页」): x-auth phone,
 * x-signed, x-idempotent, version gate — the global guard's stages. The body is passed as the
 * contract validated it; the client comes from the X-Platform header and the identity (the
 * sharer) from the server-side CallerContext inside the use case. Use-case errors keep their code
 * and HTTP status.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax), as for the convert.
 */
export class SharesController {
  readonly #shares: SharesService;

  constructor(shares: SharesService) {
    this.#shares = shares;
  }

  async create(request: CreateShareHttpRequest): Promise<CreateShareResponse> {
    const result = await this.#shares.create({
      body: request.body,
      idempotencyKey: header(request, 'idempotency-key'),
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
      client: header(request, 'x-platform') as CreateShareInput['client'],
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as CreateShareResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = SharesController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Inject(SharesService)(SharesController, undefined, 0);
  Req()(prototype, 'create', 0);
  Post('shares')(prototype, 'create', descriptor);
  HttpCode(200)(prototype, 'create', descriptor);
  RouteSchema(contractRouteSchema('createShare'))(prototype, 'create', descriptor);
  Controller('v1')(SharesController);
}
