// Contract operation `landingRegister` (POST /v1/invites/landing-register; x-auth none, x-signed
// false, x-idempotent, no version gate; task B1-11h, 08 BR-INV-05, BR-ID-32). HTTP entry only: the
// order of checks, the transaction and every write are the landing registration service's
// (application/landing-register.ts); the contract tag is growth, the route lives in identity
// (orchestrator ruling E3: account, SMS code, consents and the IP limit are identity's; the invite
// checks and the binding are growth's port).
// - The app is X-App-Id; there is no token, no signature, no device id, nothing issued (no token,
//   no cookie). The body is contract-validated (20001 before this handler).
// - Answers before the idempotency module (10004, 20001 phone_invalid, 50001 legal versions) are
//   thrown as HttpExceptions (the global filter writes them unchanged); the idempotency module's
//   answers (the handler's, a replay or its own) are written as they are, with Retry-After only on
//   a 42901 of this call's handler (42901 is never stored).
// Without the service (no database, Redis, field cipher, idempotency or growth port) the route
// fails closed with 50001.
import { Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { LandingRegisterService } from '../../application/landing-register.ts';
import { LANDING_REGISTER } from '../../application/tokens.ts';

/** What this controller reads of the Fastify request, already checked by the route schema. */
export interface LandingRegisterHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Fastify's client address (proxy trust only from the configured trusted proxies). */
  readonly ip: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'LandingRegisterRequest'>;
}

/** What this controller writes on the Fastify reply. */
export interface LandingRegisterRawReply {
  code(statusCode: number): LandingRegisterRawReply;
  header(name: string, value: string): LandingRegisterRawReply;
  type(contentType: string): LandingRegisterRawReply;
  send(payload: string): unknown;
}

function header(request: LandingRegisterHttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('v1')
export class LandingRegisterController {
  constructor(@Inject(LANDING_REGISTER) private readonly service: LandingRegisterService | null) {}

  @Post('invites/landing-register')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('landingRegister'))
  async landingRegister(
    @Req() request: LandingRegisterHttpRequest,
    @Res() reply: LandingRegisterRawReply,
  ): Promise<void> {
    if (this.service === null) {
      throw new Error('identity: landing registration needs the database, Redis and its ports');
    }
    const appId = header(request, 'x-app-id');
    if (appId === undefined) throw new Error('identity: landing registration without X-App-Id');
    const channel = header(request, 'x-channel');
    const answer = await this.service.register({
      app_id: appId,
      body: request.body,
      ...(channel === undefined ? {} : { header_channel: channel }),
      client_ip: request.ip,
      idempotency_key: header(request, 'idempotency-key'),
      trace_id: request.id,
    });
    if (answer.kind === 'refused') throw new HttpException(answer.envelope, answer.status);
    if (answer.retryAfter !== undefined) reply.header('Retry-After', String(answer.retryAfter));
    reply.code(answer.status).type('application/json; charset=utf-8').send(answer.body);
  }
}
