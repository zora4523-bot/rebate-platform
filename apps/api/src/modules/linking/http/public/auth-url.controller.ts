import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { AuthClient, UnionAuthUrlService } from '../../application/union-auth-url.ts';

type UnionAuthUrlResponse = Schema<'UnionAuthUrlResponse'>;

/** Nest injection token of the per-request auth-url use case (linking.module.ts). */
export const UNION_AUTH_URL = Symbol('UNION_AUTH_URL');

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface UnionAuthUrlHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params: { readonly platform: string };
  readonly query?: { readonly installed?: Schema<'InstalledState'> };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function header(request: UnionAuthUrlHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Contract operation `getUnionAuthUrl` (B1-06g; BR-ID-17, BR-ID-22, BR-ID-24): x-auth login, not
 * signed, not idempotent. Only taobao and pdd take a user authorization; any other platform of
 * the shared enum (jd) is 20001. The client of the device record is chosen inside the use case;
 * X-Platform is only the declaration it is compared with. Use-case errors keep their code and
 * HTTP status. Decorators are applied as plain calls, as in the open's controller.
 */
export class UnionAuthUrlController {
  readonly #service: UnionAuthUrlService;

  constructor(service: UnionAuthUrlService) {
    this.#service = service;
  }

  async get(request: UnionAuthUrlHttpRequest): Promise<UnionAuthUrlResponse> {
    // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
    const traceId = header(request, 'x-trace-id') || request.id;
    const platform = request.params.platform;
    if (platform !== 'taobao' && platform !== 'pdd') {
      throw new HttpException({ code: 20001, msg: '参数错误', trace_id: traceId }, 400);
    }
    const installed = request.query?.installed;
    const result = await this.#service.get({
      platform,
      reportedClient: header(request, 'x-platform') as AuthClient,
      ...(installed === undefined ? {} : { installed }),
      traceId,
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as UnionAuthUrlResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = UnionAuthUrlController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Inject(UNION_AUTH_URL)(UnionAuthUrlController, undefined, 0);
  Req()(prototype, 'get', 0);
  Get('unions/:platform/auth-url')(prototype, 'get', descriptor);
  RouteSchema(contractRouteSchema('getUnionAuthUrl'))(prototype, 'get', descriptor);
  Controller('v1')(UnionAuthUrlController);
}
