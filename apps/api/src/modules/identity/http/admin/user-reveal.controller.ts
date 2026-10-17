// POST /admin/v1/users/{user_id}/reveal (adminRevealUserField; BR-ID-33, F1-07a). Mounted only by
// IdentityAdminModule on the admin entry. The admin request check has verified the admin_token and
// the route schema the body (field enum phone, reason 1–200) before this runs; the operation guard
// checks the account, pii.reveal_phone and its totp step-up, and consumes the step-up token only
// after a 200 with code 0. Refusals are thrown inside the guard so a refused reveal never uses
// up the token. The full value is in the response body only, with Cache-Control: no-store.
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
import { AdminRevealFieldsError, AdminUserReveal } from '../../application/admin-user-reveal.ts';

interface RevealRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** Point of field=phone (specs/permissions.yaml, totp tier). */
const PERMISSION_BY_FIELD: Readonly<Record<string, string | undefined>> = {
  phone: 'pii.reveal_phone',
};

export class AdminUserRevealController {
  readonly #guard: AdminOperationGuard;
  readonly #reveal: AdminUserReveal;

  constructor(guard: AdminOperationGuard, reveal: AdminUserReveal) {
    this.#guard = guard;
    this.#reveal = reveal;
  }

  async reveal(
    request: RevealRequest,
    userId: string,
    body: Schema<'AdminUserRevealRequest'>,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUserRevealResponse'>> {
    reply.header('Cache-Control', 'no-store');
    const permission = PERMISSION_BY_FIELD[body.field];
    if (permission === undefined) throw refusal(new AdminRevealFieldsError(['field']), request.id);
    let response: Schema<'AdminUserRevealResponse'> | undefined;
    await this.#guard.run({ request, permission }, async (actor) => {
      try {
        const value = await this.#reveal.reveal({
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          userId,
          field: body.field,
          reason: body.reason,
        });
        response = {
          code: 0,
          msg: '',
          data: { user_id: userId, field: body.field, value },
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) {
      throw new Error('identity: admin guard returned without an answer');
    }
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminRevealFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  return error;
}

// Plain decorator calls, as content's admin controllers (no parameter decorators in syntax).
{
  const prototype = AdminUserRevealController.prototype;
  const reveal = Object.getOwnPropertyDescriptor(prototype, 'reveal')!;
  Inject(AdminOperationGuard)(AdminUserRevealController, undefined, 0);
  Inject(AdminUserReveal)(AdminUserRevealController, undefined, 1);
  Req()(prototype, 'reveal', 0);
  Param('user_id')(prototype, 'reveal', 1);
  Body()(prototype, 'reveal', 2);
  Res({ passthrough: true })(prototype, 'reveal', 3);
  Post(':user_id/reveal')(prototype, 'reveal', reveal);
  HttpCode(200)(prototype, 'reveal', reveal);
  RouteSchema(contractRouteSchema('adminRevealUserField'))(prototype, 'reveal', reveal);
  Controller('admin/v1/users')(AdminUserRevealController);
}
