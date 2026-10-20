// GET /v1/me/labor-agreement (getLaborAgreement) and POST /v1/me/labor-agreement/sign
// (signLaborAgreement); 规划/08 BR-WDR-31; tasks B1-13h, B1-13l (version mismatch → 10004).
// Contract: both x-auth realname (stage ⑨ answers 30304 first), h5_token refused with 10403
// (access-tokens.ts). The signature is x-signed and x-idempotent: it runs in the idempotency claim's
// transaction (executeInTransaction), so the consent record and the stored result commit together;
// results stored by the idempotency rule (0 and 3xxxx) replay, 1xxxx / 2xxxx / 5xxxx (the version
// mismatch 10004 included) leave the key reusable (a corrected request may reuse it).
// `msg` is a fixed fallback text (clients show their dictionary text error.<code>); `data` carries
// only what the result defines, never a submitted value.
import { Controller, Get, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import type {
  LaborAgreementService,
  SignLaborAgreementResult,
} from '../../application/labor-agreement.ts';
import { LABOR_AGREEMENT } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

interface LaborAgreementRequest extends CheckedRequest {
  readonly id: string;
}

interface SignLaborAgreementHttpRequest extends LaborAgreementRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'SignLaborAgreementRequest'>;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

const SIGN_PATH = '/v1/me/labor-agreement/sign';

const ERRORS = {
  10004: { status: 403, msg: '请先阅读并签署最新版劳务协议' },
  20001: { status: 400, msg: '填写内容有误，请检查' },
  30304: { status: 422, msg: '未实名' },
  50001: { status: 500, msg: '服务端错误' },
} as const;

function signErrorData(result: Exclude<SignLaborAgreementResult, { readonly code: 0 }>): {
  readonly data?: Record<string, unknown>;
} {
  if (result.code === 10004) return { data: { consent_type: result.data.consent_type } };
  if (result.code === 20001) return { data: { fields: [...result.data.fields] } };
  return {};
}

/** The HTTP result of a signature (exported for its unit test). */
export function signResponse(result: SignLaborAgreementResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'EmptyResponse'> = { code: 0, msg: '', data: {}, trace_id: traceId };
    return { status: 200, envelope };
  }
  const error = ERRORS[result.code];
  return {
    status: error.status,
    envelope: {
      code: result.code,
      msg: error.msg,
      ...signErrorData(result),
      trace_id: traceId,
    },
  };
}

@Controller('v1')
export class LaborAgreementController {
  constructor(
    @Inject(LABOR_AGREEMENT) private readonly agreements: LaborAgreementService | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Get('me/labor-agreement')
  @RouteSchema(contractRouteSchema('getLaborAgreement'))
  async read(@Req() request: LaborAgreementRequest): Promise<Schema<'LaborAgreementResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.agreements === null) {
      throw new Error('identity: the labor agreement needs the database and the field cipher');
    }
    const result = await this.agreements.read({
      app_id: principal.app_id,
      user_id: principal.uid,
    });
    if (result.code !== 0) throw identityFailure(result, request.id);
    return { code: 0, msg: '', data: result.data, trace_id: request.id };
  }

  @Post('me/labor-agreement/sign')
  @RouteSchema(contractRouteSchema('signLaborAgreement'))
  async sign(@Req() request: SignLaborAgreementHttpRequest, @Res() reply: RawReply): Promise<void> {
    const principal = tokenPrincipal(request);
    const device = request.verifiedDevice;
    if (
      principal === undefined ||
      device === undefined ||
      this.agreements === null ||
      this.idempotency === undefined
    ) {
      throw new Error('identity: signing needs storage and a verified token and device');
    }
    const agreements = this.agreements;
    const key = request.headers['idempotency-key'];
    const result = await this.idempotency.executeInTransaction(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: device.deviceId, phoneHmac: null },
        method: 'POST',
        path: SIGN_PATH,
        key: typeof key === 'string' ? key : undefined,
        body: request.body,
        traceId: request.id,
      },
      async (trx) =>
        signResponse(
          await agreements.sign(trx, {
            app_id: principal.app_id,
            user_id: principal.uid,
            device_id: device.deviceId,
            body: request.body,
          }),
          request.id,
        ),
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }
}
