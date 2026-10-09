// /admin/v1/auth (F1-06k; contract operations adminLogin, adminChangeInitialPassword,
// adminGetTotpBindingSecret, adminBindTotp, adminVerifyTotp, adminLogout). Served by the admin
// entry only. The admin request check (application/admin-check.ts) has already refused a source
// outside the whitelist (10403) and, for logout, verified the admin_token (10001) before the body
// schema ran; the handlers only take the parameters, call the use case and map its answer.
import { Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type {
  AdminAuthFailure,
  AdminAuthService,
  LoginStepResult,
  SessionResult,
} from '../../application/admin-login.ts';
import { ADMIN_AUTH } from '../../application/tokens.ts';

type StepResponse = Schema<'AdminLoginStepResponse'>;
type SessionResponse = Schema<'AdminSessionResponse'>;
type SecretResponse = Schema<'AdminTotpSecretResponse'>;
type EmptyResponse = Schema<'EmptyResponse'>;

interface AdminRequest<Body> extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as Fastify derived it (TRUSTED_PROXIES aware). */
  readonly ip: string;
  readonly body: Body;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** Fallback texts (clients show their dictionary text error.<code>). */
const MESSAGES = Object.freeze({
  10001: '登录步骤已过期，请重新登录',
  10008: '账号或密码不正确',
  10009: '账号已锁定，请稍后再试',
  totp_invalid: '动态码不正确，请输入验证器上最新的 6 位动态码',
  totp_bind_invalid:
    '动态码不正确，绑定没有完成。请确认手机时间准确，再输入验证器上最新的 6 位动态码。',
});

/** contracts/error-codes.yaml statuses and data of the login failures. */
function failure(result: AdminAuthFailure, traceId: string): HttpException {
  switch (result.code) {
    case 10001:
      return new HttpException(
        {
          code: 10001,
          msg: MESSAGES[10001],
          data: { reason: 'login_ticket_expired' },
          trace_id: traceId,
        },
        401,
      );
    case 10008:
      return new HttpException({ code: 10008, msg: MESSAGES[10008], trace_id: traceId }, 401);
    case 10009:
      return new HttpException(
        {
          code: 10009,
          msg: MESSAGES[10009],
          data: { locked_until: result.lockedUntil.toISOString() },
          trace_id: traceId,
        },
        403,
      );
    case 20001: {
      const { statusCode, body } = fieldsErrorEnvelope(['new_password'], traceId);
      return new HttpException(body, statusCode);
    }
    case 20002:
      return new HttpException(
        {
          code: 20002,
          msg: MESSAGES[result.reason],
          data: { reason: result.reason },
          trace_id: traceId,
        },
        400,
      );
  }
}

function step(result: LoginStepResult | AdminAuthFailure, traceId: string): StepResponse {
  if (result.code !== 0) throw failure(result, traceId);
  return {
    code: 0,
    msg: '',
    data: {
      next: result.next,
      login_ticket: result.ticket,
      ticket_expires_at: result.expiresAt.toISOString(),
    },
    trace_id: traceId,
  };
}

function session(result: SessionResult | AdminAuthFailure, traceId: string): SessionResponse {
  if (result.code !== 0) throw failure(result, traceId);
  return {
    code: 0,
    msg: '',
    data: {
      admin_token: result.token,
      expires_at: result.expiresAt.toISOString(),
      idle_timeout_sec: result.idleTimeoutSec,
    },
    trace_id: traceId,
  };
}

@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(@Inject(ADMIN_AUTH) private readonly auth: AdminAuthService) {}

  /** adminLogin: account and password → the ticket of the next step (never an admin_token). */
  @Post('login')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminLogin'))
  async login(@Req() request: AdminRequest<Schema<'AdminLoginRequest'>>): Promise<StepResponse> {
    const result = await this.auth.login({
      username: request.body.username,
      password: request.body.password,
      ip: request.ip,
    });
    return step(result, request.id);
  }

  /** adminChangeInitialPassword: replace the initial password → the next ticket. */
  @Post('password')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminChangeInitialPassword'))
  async changePassword(
    @Req() request: AdminRequest<Schema<'AdminChangePasswordRequest'>>,
  ): Promise<StepResponse> {
    const result = await this.auth.changeInitialPassword({
      ticket: request.body.login_ticket,
      newPassword: request.body.new_password,
      ip: request.ip,
    });
    return step(result, request.id);
  }

  /** adminGetTotpBindingSecret: the pending secret of a bind ticket (not consumed; no-store). */
  @Post('totp/secret')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminGetTotpBindingSecret'))
  async bindingSecret(
    @Req() request: AdminRequest<Schema<'AdminLoginTicketRequest'>>,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<SecretResponse> {
    reply.header('Cache-Control', 'no-store');
    const result = await this.auth.bindingSecret({ ticket: request.body.login_ticket });
    if (result.code !== 0) throw failure(result, request.id);
    return {
      code: 0,
      msg: '',
      data: { totp_secret: result.secret, otpauth_uri: result.otpauthUri },
      trace_id: request.id,
    };
  }

  /** adminBindTotp: confirm the first binding with a code → admin_token. */
  @Post('totp/bind')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminBindTotp'))
  async bindTotp(
    @Req() request: AdminRequest<Schema<'AdminTotpCodeRequest'>>,
  ): Promise<SessionResponse> {
    const result = await this.auth.bindTotp({
      ticket: request.body.login_ticket,
      code: request.body.code,
      ip: request.ip,
    });
    return session(result, request.id);
  }

  /** adminVerifyTotp: the second login step → admin_token. */
  @Post('totp')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminVerifyTotp'))
  async verifyTotp(
    @Req() request: AdminRequest<Schema<'AdminTotpCodeRequest'>>,
  ): Promise<SessionResponse> {
    const result = await this.auth.verifyTotp({
      ticket: request.body.login_ticket,
      code: request.body.code,
      ip: request.ip,
    });
    return session(result, request.id);
  }

  /** adminLogout: revoke the session of the verified admin_token. */
  @Post('logout')
  @HttpCode(200)
  @RouteSchema(contractRouteSchema('adminLogout'))
  async logout(@Req() request: AdminRequest<unknown>): Promise<EmptyResponse> {
    const principal = adminPrincipal(request);
    // Unreachable behind the admin token check; never answer 200 for an unchecked request.
    if (principal === undefined) throw new Error('admin: logout without a verified admin_token');
    await this.auth.logout({
      adminId: principal.adminId,
      appId: principal.appId,
      sessionId: principal.sessionId,
      ip: request.ip,
    });
    return { code: 0, msg: '', data: {}, trace_id: request.id };
  }
}
