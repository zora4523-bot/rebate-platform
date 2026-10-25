// POST /admin/v1/users/{user_id}/realname-correction (adminCorrectUserRealname, CT-24q; BR-ID-25 细则
// 「实名更正」; B1-27a). Mounted only by IdentityAdminModule on the admin entry. The admin request
// check has verified the admin_token and the contract route schema the params and body before this
// runs (20001 data.fields); the operation guard checks the account, user.realname_fix and its totp
// step-up, and consumes the step-up token only after a 200 with code 0. Refusals are thrown inside
// the guard so a refused submission never uses up the step-up token. No Idempotency-Key (04 §6.6).
// The answer is the corrected real name, masked; Cache-Control: no-store.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminRealnameCorrection,
  type AdminRealnameCorrectionResult,
} from '../../application/admin-realname-correction.ts';

interface CorrectionRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

type CorrectionBody = Schema<'AdminRealnameCorrectionRequest'>;
type CorrectionResponse = Schema<'AdminUserRealnameResponse'>;

/** specs/permissions.yaml: totp tier. */
const PERMISSION = 'user.realname_fix';

/** Statuses of contracts/error-codes.yaml and the texts of contracts/texts.default.json. */
const REFUSALS = {
  30405: { status: 422, msg: '该身份证已被其他账号实名' },
  30406: { status: 422, msg: '实名核验未通过，请核对姓名与身份证号' },
  30407: { status: 422, msg: '年龄不满足实名要求' },
  30419: { status: 422, msg: '该用户当前不受理这项代办' },
  44001: { status: 403, msg: '操作未通过安全校验' },
  50301: { status: 503, msg: '服务暂不可用，请稍后再试' },
  50401: { status: 504, msg: '出了点问题，请稍后再试' },
} as const;

export class AdminUserRealnameController {
  readonly #guard: AdminOperationGuard;
  readonly #corrections: AdminRealnameCorrection;

  constructor(guard: AdminOperationGuard, corrections: AdminRealnameCorrection) {
    this.#guard = guard;
    this.#corrections = corrections;
  }

  async correct(
    request: CorrectionRequest,
    userId: string,
    body: CorrectionBody,
    reply?: HeaderReply,
  ): Promise<CorrectionResponse> {
    reply?.header('Cache-Control', 'no-store');
    let response: CorrectionResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const result = await this.#corrections.correct({
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        userId,
        name: body.name,
        idNo: body.id_no,
        reason: body.reason,
      });
      if (result.code !== 0) throw rejected(result, request.id);
      response = { code: 0, msg: '', data: result.data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) {
      throw new Error('identity: admin guard returned without an answer');
    }
    return response;
  }
}

function rejected(
  result: Exclude<AdminRealnameCorrectionResult, { code: 0 }>,
  traceId: string,
): HttpException {
  if (result.code === 20001) {
    const refused = fieldsErrorEnvelope(result.data.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  const { status, msg } = REFUSALS[result.code];
  // 44001 here carries no risk_msg_code: a console refusal, no appeal (BR-ID-36).
  const data = result.code === 30419 ? { data: { ...result.data } } : {};
  return new HttpException({ code: result.code, msg, ...data, trace_id: traceId }, status);
}

// Plain decorator calls, as the other identity admin controllers.
{
  const prototype = AdminUserRealnameController.prototype;
  const correct = Object.getOwnPropertyDescriptor(prototype, 'correct')!;
  Inject(AdminOperationGuard)(AdminUserRealnameController, undefined, 0);
  Inject(AdminRealnameCorrection)(AdminUserRealnameController, undefined, 1);
  Req()(prototype, 'correct', 0);
  Param('user_id')(prototype, 'correct', 1);
  Body()(prototype, 'correct', 2);
  Res({ passthrough: true })(prototype, 'correct', 3);
  Post(':user_id/realname-correction')(prototype, 'correct', correct);
  HttpCode(200)(prototype, 'correct', correct);
  RouteSchema(contractRouteSchema('adminCorrectUserRealname'))(prototype, 'correct', correct);
  Controller('admin/v1/users')(AdminUserRealnameController);
}
