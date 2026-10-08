import { Controller, Get, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
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

  async bind(request: BindingsHttpRequest): Promise<UnionBindingResponse> {
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
  Post('unions/:platform/bindings')(prototype, 'bind', bind);
  HttpCode(200)(prototype, 'bind', bind);
  RouteSchema(contractRouteSchema('bindUnion'))(prototype, 'bind', bind);
  Req()(prototype, 'list', 0);
  Get('unions/bindings')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listUnionBindings'))(prototype, 'list', list);
  Controller('v1')(UnionBindingsController);
}
