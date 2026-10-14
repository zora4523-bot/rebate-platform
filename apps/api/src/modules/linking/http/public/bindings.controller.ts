import { Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { UnionBindingsService } from '../../application/union-bindings.ts';

type UnionBindingResponse = Schema<'UnionBindingResponse'>;
type UnionBindingsResponse = Schema<'UnionBindingsResponse'>;

/** Nest injection token of the per-request bindings use case (linking.module.ts). */
export const UNION_BINDINGS = Symbol('UNION_BINDINGS');

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface BindingsHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params?: { readonly platform?: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: Schema<'BindUnionRequest'>;
}

/** What this controller writes on the Fastify reply besides the body. */
interface HeaderReply {
  header(name: string, value: string): unknown;
}

function header(request: BindingsHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function traceOf(request: BindingsHttpRequest): string {
  // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
  return header(request, 'x-trace-id') || request.id;
}

/**
 * Contract operations `bindUnion` (x-auth login, signed, idempotent) and `listUnionBindings`
 * (x-auth login) — B1-06h; BR-ID-17, BR-ID-19, BR-ID-24. The identity and the device record's
 * client come from the server inside the use case; X-Platform is only a declaration. Use-case
 * errors keep their code and HTTP status. Decorators are applied as plain calls, as in the open's
 * controller.
 */
export class UnionBindingsController {
  readonly #service: UnionBindingsService;

  constructor(service: UnionBindingsService) {
    this.#service = service;
  }

  async bind(request: BindingsHttpRequest, reply?: HeaderReply): Promise<UnionBindingResponse> {
    const key = request.headers['idempotency-key'];
    const result = await this.#service.bind({
      platform: request.params?.platform ?? '',
      body: request.body!,
      idempotencyKey: typeof key === 'string' ? key : undefined,
      traceId: traceOf(request),
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as UnionBindingResponse;
    }
    // 42901 of the bounded admission queue (B1-06za): Retry-After as the global rate limit's.
    if (result.retryAfterSec !== undefined) {
      reply?.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterSec))));
    }
    throw new HttpException(result.envelope, result.status);
  }

  async list(request: BindingsHttpRequest): Promise<UnionBindingsResponse> {
    const result = await this.#service.list({ traceId: traceOf(request) });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as UnionBindingsResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = UnionBindingsController.prototype;
  const bind = Object.getOwnPropertyDescriptor(prototype, 'bind')!;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Inject(UNION_BINDINGS)(UnionBindingsController, undefined, 0);
  Req()(prototype, 'bind', 0);
  Res({ passthrough: true })(prototype, 'bind', 1);
  Post('unions/:platform/bindings')(prototype, 'bind', bind);
  HttpCode(200)(prototype, 'bind', bind);
  RouteSchema(contractRouteSchema('bindUnion'))(prototype, 'bind', bind);
  Req()(prototype, 'list', 0);
  Get('unions/bindings')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listUnionBindings'))(prototype, 'list', list);
  Controller('v1')(UnionBindingsController);
}
