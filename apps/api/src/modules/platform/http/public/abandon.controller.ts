import { Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import type { Idempotency } from '../../idempotency/index.ts';
import { contractRouteSchema } from '../../validation/contract-routes.ts';
import type { CheckedRequest } from '../request-checks.ts';
import { IDEMPOTENCY } from '../../idempotency/token.ts';
import { tokenPrincipal } from '../token-context.ts';

/** What this controller reads of the Fastify request, already checked by stages ①–③ and the schema. */
export interface AbandonHttpRequest extends CheckedRequest {
  /** Trace id set by `genReqId` (the well-formed X-Trace-Id, else a random UUID). */
  readonly id: string;
  readonly body: Schema<'AbandonIdempotencyKeyRequest'>;
}

/** What this controller writes on the Fastify reply. */
export interface RawReply {
  code(statusCode: number): RawReply;
  type(contentType: string): RawReply;
  send(payload: string): unknown;
}

/**
 * Contract operation `abandonIdempotencyKey` (规划/04 §6.1; 08 BR-ID-10 细则「作废接口」): x-auth
 * login, x-signed, no Idempotency-Key. The subject is the token's principal only (stage ②: uid and
 * app_id), never the body or X-App-Id; the body's action and idempotency_key go to the primitive
 * unchanged (it answers 20001 itself). Its IdempotentResponse is written as is: HTTP status and the
 * body bytes, no re-serialisation. An IdempotencyError('outcome_unknown') propagates to the global
 * error filter, which closes the connection without an envelope (BR-ID-10「服务端的配合」); anything
 * else becomes 50001 there. The version gate and session scopes (x-min-version-gate conditional,
 * x-session-scopes) are B1-03c's guard; the 10006 / 10007 whitelists are the ban guard's. Without a
 * database (no idempotency primitive) every call fails closed with 50001.
 *
 * Nest's decorators are applied as plain calls below (not decorator syntax): platform.module.ts is
 * reachable from the test project, whose compiler settings have no legacy decorators.
 */
export class AbandonController {
  readonly #idempotency: Idempotency | undefined;

  constructor(idempotency: Idempotency | undefined) {
    this.#idempotency = idempotency;
  }

  async abandon(request: AbandonHttpRequest, reply: RawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    if (this.#idempotency === undefined || principal === undefined) {
      throw new Error('platform: abandon needs the database and a verified token');
    }
    const result = await this.#idempotency.abandon({
      appId: principal.app_id,
      userId: principal.uid,
      action: request.body.action,
      key: request.body.idempotency_key,
      traceId: request.id,
    });
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}

{
  const prototype = AbandonController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'abandon')!;
  Inject(IDEMPOTENCY)(AbandonController, undefined, 0);
  Optional()(AbandonController, undefined, 0);
  Req()(prototype, 'abandon', 0);
  Res()(prototype, 'abandon', 1);
  Post('idempotency-keys/abandon')(prototype, 'abandon', descriptor);
  HttpCode(200)(prototype, 'abandon', descriptor);
  RouteSchema(contractRouteSchema('abandonIdempotencyKey'))(prototype, 'abandon', descriptor);
  Controller('v1')(AbandonController);
}
