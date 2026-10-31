// B1-03zd: the risk appeal console reads (CT-24r; BR-ID-36, BR-ID-33) — GET /admin/v1/appeals
// (adminListAppeals), GET /admin/v1/appeals/{appeal_id} (adminGetAppeal) and GET
// /admin/v1/blocked-requests (adminListBlockedRequests). Mounted only by RiskAppealsAdminModule on
// the admin entry. The admin request check has verified the admin_token and the route schema the
// query before this runs; the operation guard checks the account and the permission point
// risk.appeal, read only (no step-up; an X-Step-Up-Token header is ignored). The answer is
// no-store. Only a phone lookup that finds something writes an audit record (in the service).
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminAppealsFieldsError,
  AdminAppealsRead,
  type AdminAppealListQuery,
  type AdminAppealsActor,
  type AdminBlockedRequestQuery,
} from '../../application/admin-appeals-read.ts';

interface AppealsRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

const PERMISSION = 'risk.appeal';
const PHONE_INVALID_MESSAGE = '请输入 11 位中国大陆手机号';

type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

export class AdminAppealsController {
  readonly #guard: AdminOperationGuard;
  readonly #reads: AdminAppealsRead;

  constructor(guard: AdminOperationGuard, reads: AdminAppealsRead) {
    this.#guard = guard;
    this.#reads = reads;
  }

  list(
    request: AppealsRequest,
    query: AdminAppealListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAppealPageResponse'>> {
    return this.run(request, reply, (actor) => this.#reads.list(actor, query));
  }

  detail(
    request: AppealsRequest,
    appealId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAppealResponse'>> {
    return this.run(request, reply, (actor) => this.#reads.get(actor, appealId));
  }

  blockedRequests(
    request: AppealsRequest,
    query: AdminBlockedRequestQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminBlockedRequestPageResponse'>> {
    return this.run(request, reply, (actor) => this.#reads.blockedRequests(actor, query));
  }

  private async run<T>(
    request: AppealsRequest,
    reply: HeaderReply,
    read: (actor: AdminAppealsActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      try {
        const data = await read({
          appId: actor.appId,
          adminId: actor.adminId,
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
  if (!(error instanceof AdminAppealsFieldsError)) return error;
  if (error.reason !== undefined) {
    return new HttpException(
      {
        code: 20001,
        msg: PHONE_INVALID_MESSAGE,
        data: { fields: [...error.fields], reason: error.reason },
        trace_id: traceId,
      },
      400,
    );
  }
  const refused = fieldsErrorEnvelope(error.fields, traceId);
  return new HttpException(refused.body, refused.statusCode);
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminAppealsController.prototype;
  Inject(AdminOperationGuard)(AdminAppealsController, undefined, 0);
  Inject(AdminAppealsRead)(AdminAppealsController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('appeals')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListAppeals'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('appeal_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('appeals/:appeal_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetAppeal'))(prototype, 'detail', detail);
  const blocked = Object.getOwnPropertyDescriptor(prototype, 'blockedRequests')!;
  Req()(prototype, 'blockedRequests', 0);
  Query()(prototype, 'blockedRequests', 1);
  Res({ passthrough: true })(prototype, 'blockedRequests', 2);
  Get('blocked-requests')(prototype, 'blockedRequests', blocked);
  RouteSchema(contractRouteSchema('adminListBlockedRequests'))(
    prototype,
    'blockedRequests',
    blocked,
  );
  Controller('admin/v1')(AdminAppealsController);
}
