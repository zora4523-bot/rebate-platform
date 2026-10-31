// B1-03ze: the risk appeal console writes (CT-24r; BR-ID-36, BR-ID-31) — POST /admin/v1/appeals
// (adminRegisterAppeal), POST /admin/v1/appeals/{appeal_id}/claim (adminClaimAppeal) and POST
// /admin/v1/appeals/{appeal_id}/resolve (adminResolveAppeal). Mounted only by
// RiskAppealsAdminModule on the admin entry. The admin request check has verified the admin_token
// and the route schema the body before this runs. The operation guard checks the account and
// risk.appeal (no step-up tier: an X-Step-Up-Token header is not used). A resolution then runs the
// contract's order — body → appeal_id → state / version → the extra point → its step-up — by
// asking the service what the decision needs and, when it needs risk.ban / risk.freeze /
// risk.blocklist, running the write inside a second guard call for that point, which checks the
// totp step-up and consumes the token only after the write succeeded. Refusals are thrown inside
// the guards so a refused write never uses up a token. No Idempotency-Key (04 §6.6): the
// row_version compare-and-set (claim, resolve) and the processing appeal (register) make a repeat
// harmless.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminAppealAttemptsUsedUpError,
  AdminAppealConflictError,
  AdminAppealsWrite,
  AdminAppealsWriteFieldsError,
  type AdminAppealsWriteActor,
} from '../../application/admin-appeals-write.ts';
import { AdminAppealsFieldsError } from '../../application/admin-appeals-read.ts';

interface AppealsRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

const PERMISSION = 'risk.appeal';

type Detail = Schema<'AdminAppealDetail'>;
type Envelope = { code: 0; msg: string; data: Detail; trace_id: string };

export class AdminAppealsWriteController {
  readonly #guard: AdminOperationGuard;
  readonly #writes: AdminAppealsWrite;

  constructor(guard: AdminOperationGuard, writes: AdminAppealsWrite) {
    this.#guard = guard;
    this.#writes = writes;
  }

  register(request: AppealsRequest, body: unknown): Promise<Schema<'AdminAppealResponse'>> {
    return this.run(request, (actor) => this.#writes.register(actor, body));
  }

  claim(
    request: AppealsRequest,
    appealId: string,
    body: unknown,
  ): Promise<Schema<'AdminAppealResponse'>> {
    return this.run(request, (actor) => this.#writes.claim(actor, appealId, body));
  }

  resolve(
    request: AppealsRequest,
    appealId: string,
    body: unknown,
  ): Promise<Schema<'AdminAppealResponse'>> {
    return this.run(request, async (actor) => {
      const prepared = await this.#writes.prepareResolve(actor, appealId, body);
      const extra = prepared.requirement.permission;
      if (extra === null) return prepared.run();
      // The extra point and its totp step-up, checked only now (after the CAS check).
      let data: Detail | undefined;
      await this.#guard.run({ request, permission: extra }, async () => {
        try {
          data = await prepared.run();
        } catch (error) {
          throw refusal(error, request.id);
        }
        return { statusCode: 200, body: { code: 0, data } };
      });
      if (data === undefined) throw new Error('risk: admin guard returned without an answer');
      return data;
    });
  }

  private async run(
    request: AppealsRequest,
    write: (actor: AdminAppealsWriteActor) => Promise<Detail>,
  ): Promise<Envelope> {
    let response: Envelope | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (admin: AdminActor) => {
      try {
        const data = await write({
          appId: admin.appId,
          adminId: admin.adminId,
          loginName: admin.loginName,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('risk: admin guard returned without an answer');
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminAppealsWriteFieldsError || error instanceof AdminAppealsFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AdminAppealConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'appeal' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AdminAppealAttemptsUsedUpError) {
    return new HttpException(
      { code: 30418, msg: '这项申诉的次数已用完，不能再提交申诉', trace_id: traceId },
      422,
    );
  }
  return error;
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminAppealsWriteController.prototype;
  Inject(AdminOperationGuard)(AdminAppealsWriteController, undefined, 0);
  Inject(AdminAppealsWrite)(AdminAppealsWriteController, undefined, 1);
  const register = Object.getOwnPropertyDescriptor(prototype, 'register')!;
  Req()(prototype, 'register', 0);
  Body()(prototype, 'register', 1);
  Post('appeals')(prototype, 'register', register);
  HttpCode(200)(prototype, 'register', register);
  RouteSchema(contractRouteSchema('adminRegisterAppeal'))(prototype, 'register', register);
  const claim = Object.getOwnPropertyDescriptor(prototype, 'claim')!;
  Req()(prototype, 'claim', 0);
  Param('appeal_id')(prototype, 'claim', 1);
  Body()(prototype, 'claim', 2);
  Post('appeals/:appeal_id/claim')(prototype, 'claim', claim);
  HttpCode(200)(prototype, 'claim', claim);
  RouteSchema(contractRouteSchema('adminClaimAppeal'))(prototype, 'claim', claim);
  const resolve = Object.getOwnPropertyDescriptor(prototype, 'resolve')!;
  Req()(prototype, 'resolve', 0);
  Param('appeal_id')(prototype, 'resolve', 1);
  Body()(prototype, 'resolve', 2);
  Post('appeals/:appeal_id/resolve')(prototype, 'resolve', resolve);
  HttpCode(200)(prototype, 'resolve', resolve);
  RouteSchema(contractRouteSchema('adminResolveAppeal'))(prototype, 'resolve', resolve);
  Controller('admin/v1')(AdminAppealsWriteController);
}
