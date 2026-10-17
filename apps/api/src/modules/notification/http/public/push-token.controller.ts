// B1-12c: POST /v1/devices/push-token (contract reportPushToken: x-auth login, unsigned, not
// idempotent, x-min-version-gate, 10405). The token check has verified the bearer token; the
// subject is the request's principal only (tokenPrincipal: app_id, uid → user_id, sid,
// device_id), never X-App-Id / X-Device-Id or the body. The body's provider and token go to the
// reporter unchanged. Every rule outcome answers EmptyResponse { code: 0, msg: '', data: {},
// trace_id: request.id }. No principal → reject without calling the reporter.
// Mounted by NotificationModule (app.module, api entry) with contractRouteSchema('reportPushToken').
// Nest decorators are applied as plain calls (this file is reachable from the
// `test` project, whose compiler settings have no legacy decorators).
import type { Schema } from '@couli/contracts-ts';
import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  tokenPrincipal,
  type ContractOperationId,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { PushTokenReporter } from '../../application/push-token-report.ts';

export const PUSH_TOKEN_REPORTER = Symbol('PUSH_TOKEN_REPORTER');

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface PushTokenHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly body: Schema<'ReportPushTokenRequest'>;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export class PushTokenController {
  readonly #reporter: PushTokenReporter;

  constructor(reporter: PushTokenReporter) {
    this.#reporter = reporter;
  }

  async report(request: PushTokenHttpRequest): Promise<Schema<'EmptyResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    await this.#reporter.report({
      app_id: principal.app_id,
      user_id: principal.uid,
      sid: principal.sid,
      device_id: principal.device_id,
      provider: request.body.provider,
      token: request.body.token,
    });
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }
}

Controller('v1/devices')(PushTokenController);
Inject(PUSH_TOKEN_REPORTER)(PushTokenController, undefined, 0);
const reportMethod = Object.getOwnPropertyDescriptor(PushTokenController.prototype, 'report')!;
Post('push-token')(PushTokenController.prototype, 'report', reportMethod);
HttpCode(200)(PushTokenController.prototype, 'report', reportMethod);
// The orchestrator removes planned and regenerates this operation in its mechanical change.
// Until then the type assertion permits static checking; the runtime lookup still fails closed.
RouteSchema(contractRouteSchema('reportPushToken' as ContractOperationId))(
  PushTokenController.prototype,
  'report',
  reportMethod,
);
Req()(PushTokenController.prototype, 'report', 0);
