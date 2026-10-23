// /admin/v1 verify phone registration and change (B1-34i; 08 BR-ID-45; contract CT-24o operations
// adminSendMyVerifyPhoneCode, adminChangeMyVerifyPhone, adminSendAdminVerifyPhoneCode,
// adminChangeAdminVerifyPhone). Served by the admin entry only. The admin request check
// (application/admin-check.ts) has already verified the admin_token (x-auth admin: any signed-in
// account; x-auth super: a super admin, else 10403) before the body schema ran. The sends run behind
// the totp-tier step-up gate (claimed before, consumed only by the 2xx answer; refusals are thrown
// inside the gate, so they keep the step-up token usable); the changes check no step-up token
// (the step-up was made when the code was sent). The handlers only take the principal and the
// parameters, call the use case and map its answer.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminPrincipal,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { AdminAccountView } from '../../application/admin-accounts-read.ts';
import { ADMIN_MESSAGES } from '../../application/admin-check.ts';
import type {
  AdminVerifyPhoneService,
  VerifyPhoneCaller,
  VerifyPhoneCodeRefused,
  VerifyPhoneRefused,
  VerifyPhoneSendAnswer,
} from '../../application/admin-verify-phone.ts';
import type { AdminStepUpGate } from '../../application/permission-guard.ts';
import { ADMIN_STEP_UP_GATE, ADMIN_VERIFY_PHONE } from '../../application/tokens.ts';

type SendResponse = Schema<'SendSmsCodeResponse'>;
type MineResponse = Schema<'AdminVerifyPhoneResponse'>;
type AccountResponse = Schema<'AdminAccountResponse'>;
type Account = Schema<'AdminAccount'>;

/** Fallback texts (clients show their dictionary text error.<code>). */
const MESSAGES = Object.freeze({
  phone_invalid: '请输入 11 位中国大陆手机号',
  20002: '验证码错误，请重新输入',
  20003: '验证码已失效，请重新获取',
  42901: '操作太频繁，请稍后再试',
  50001: '服务繁忙，请稍后再试',
});

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface VerifyPhoneRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly params: { readonly admin_id?: string };
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

function principalOf(request: VerifyPhoneRequest): AdminPrincipal {
  const principal = adminPrincipal(request);
  // Unreachable behind the admin token check; never answer for an unchecked request.
  if (principal === undefined)
    throw new Error('admin: verify phone without a verified admin_token');
  return principal;
}

function callerOf(request: VerifyPhoneRequest): VerifyPhoneCaller {
  const principal = principalOf(request);
  return {
    appId: principal.appId,
    adminId: principal.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

function toAccount(view: AdminAccountView): Account {
  return {
    admin_id: view.adminId,
    username: view.username,
    ...(view.displayName === null ? {} : { display_name: view.displayName }),
    is_super: view.isSuper,
    status: view.status as Account['status'],
    totp_bound: view.totpBound,
    verify_phone_masked: view.verifyPhoneMasked,
    locked_until: view.lockedUntil === null ? null : view.lockedUntil.toISOString(),
    permissions: view.permissions,
    created_at: view.createdAt.toISOString(),
    row_version: view.rowVersion,
  };
}

/** A refusal of the use case as the contract's error envelope. */
function refused(
  answer:
    VerifyPhoneRefused | VerifyPhoneCodeRefused | Exclude<VerifyPhoneSendAnswer, { kind: 'sent' }>,
  traceId: string,
  reply?: HeaderReply,
): HttpException {
  switch (answer.kind) {
    case 'fields': {
      if (answer.reason !== undefined) {
        return new HttpException(
          {
            code: 20001,
            msg: MESSAGES.phone_invalid,
            data: { fields: [...answer.fields], reason: answer.reason },
            trace_id: traceId,
          },
          400,
        );
      }
      const { statusCode, body } = fieldsErrorEnvelope(answer.fields, traceId);
      return new HttpException(body, statusCode);
    }
    case 'forbidden':
      return new HttpException(
        {
          code: 10403,
          msg: ADMIN_MESSAGES[10403].admin_permission_denied,
          data: { reason: 'admin_permission_denied' },
          trace_id: traceId,
        },
        403,
      );
    case 'expired':
      return new HttpException({ code: 10001, msg: ADMIN_MESSAGES[10001], trace_id: traceId }, 401);
    case 'wrong':
      return new HttpException({ code: 20002, msg: MESSAGES[20002], trace_id: traceId }, 400);
    case 'gone':
      return new HttpException({ code: 20003, msg: MESSAGES[20003], trace_id: traceId }, 400);
    case 'limited':
      reply?.header('Retry-After', String(answer.retryAfterSec));
      return new HttpException({ code: 42901, msg: MESSAGES[42901], trace_id: traceId }, 429);
    case 'failed':
      return new HttpException({ code: 50001, msg: MESSAGES[50001], trace_id: traceId }, 500);
  }
}

@Controller('admin/v1')
export class AdminVerifyPhoneController {
  constructor(
    @Inject(ADMIN_VERIFY_PHONE) private readonly service: AdminVerifyPhoneService,
    @Inject(ADMIN_STEP_UP_GATE) private readonly gate: AdminStepUpGate,
  ) {}

  /** Runs `send` behind the totp-tier step-up; a refusal is thrown (token stays usable). */
  private async stepped(
    request: VerifyPhoneRequest,
    reply: HeaderReply,
    send: () => Promise<VerifyPhoneSendAnswer>,
  ): Promise<SendResponse> {
    const principal = principalOf(request);
    let response: SendResponse | undefined;
    await this.gate.run(
      { principal, tier: 'totp', headers: request.headers, traceId: request.id },
      async () => {
        const answer = await send();
        if (answer.kind !== 'sent') throw refused(answer, request.id, reply);
        response = {
          code: 0,
          msg: '',
          data: { resend_after_sec: answer.resendAfterSec, expires_in_sec: answer.expiresInSec },
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      },
    );
    if (response === undefined) throw new Error('admin: step-up gate returned without an answer');
    return response;
  }

  /** adminSendMyVerifyPhoneCode: a code to the signed-in account's new verify phone. */
  @Post('me/verify-phone/sms-codes')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminSendMyVerifyPhoneCode'))
  async sendMine(
    @Req() request: VerifyPhoneRequest,
    @Body() body: Schema<'AdminVerifyPhoneCodeRequest'>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SendResponse> {
    return this.stepped(request, reply, () => this.service.sendMine(callerOf(request), body.phone));
  }

  /** adminChangeMyVerifyPhone: the new verify phone takes effect with its code. */
  @Put('me/verify-phone')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminChangeMyVerifyPhone'))
  async changeMine(
    @Req() request: VerifyPhoneRequest,
    @Body() body: Schema<'AdminChangeMyVerifyPhoneRequest'>,
  ): Promise<MineResponse> {
    const answer = await this.service.changeMine(callerOf(request), body.phone, body.code);
    if (answer.kind !== 'ok') throw refused(answer, request.id);
    return {
      code: 0,
      msg: '',
      data: {
        verify_phone_masked: answer.masked,
        verify_phone_set_at: answer.setAt.toISOString(),
      },
      trace_id: request.id,
    };
  }

  /** adminSendAdminVerifyPhoneCode: a code to another account's new verify phone (super admin). */
  @Post('admins/:admin_id/verify-phone/sms-codes')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminSendAdminVerifyPhoneCode'))
  async sendFor(
    @Req() request: VerifyPhoneRequest,
    @Body() body: Schema<'AdminVerifyPhoneCodeRequest'>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SendResponse> {
    return this.stepped(request, reply, () =>
      this.service.sendFor(callerOf(request), request.params.admin_id ?? '', body.phone),
    );
  }

  /** adminChangeAdminVerifyPhone: another account's new verify phone with its code (super admin). */
  @Put('admins/:admin_id/verify-phone')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminChangeAdminVerifyPhone'))
  async changeFor(
    @Req() request: VerifyPhoneRequest,
    @Body() body: Schema<'AdminChangeAdminVerifyPhoneRequest'>,
  ): Promise<AccountResponse> {
    const answer = await this.service.changeFor(
      callerOf(request),
      request.params.admin_id ?? '',
      body,
    );
    if (answer.kind !== 'ok') throw refused(answer, request.id);
    return { code: 0, msg: '', data: toAccount(answer.account), trace_id: request.id };
  }
}
