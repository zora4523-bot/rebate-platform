// B1-12c: POST /v1/devices/push-token (contract reportPushToken: x-auth login, unsigned, not
// idempotent, x-min-version-gate, 10405). The token check has verified the bearer token; the
// subject is the request's principal only (tokenPrincipal: app_id, uid → user_id, sid,
// device_id), never X-App-Id / X-Device-Id or the body. The body's provider and token go to the
// reporter unchanged. Every rule outcome answers EmptyResponse { code: 0, msg: '', data: {},
// trace_id: request.id }. No principal → reject without calling the reporter.
// Mounted by NotificationModule (app.module, api entry) with contractRouteSchema('reportPushToken').
// SKELETON: Nest decorators are to be applied as plain calls (this file is reachable from the
// `test` project, whose compiler settings have no legacy decorators).
import type { Schema } from '@couli/contracts-ts';
import type { TokenPrincipal } from '../../../platform/index.ts';
import type { PushTokenReporter } from '../../application/push-token-report.ts';

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
  constructor(reporter: PushTokenReporter) {
    void reporter;
    throw new Error('NotImplemented: PushTokenController');
  }

  report(request: PushTokenHttpRequest): Promise<Schema<'EmptyResponse'>> {
    void request;
    throw new Error('NotImplemented: PushTokenController.report');
  }
}
