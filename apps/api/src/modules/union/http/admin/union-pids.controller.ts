// GET / POST /admin/v1/union-pids, PATCH /admin/v1/union-pids/{pid_id}, POST
// /admin/v1/union-pids/{pid_id}/activate | retire (B1-22h; adminListUnionPids / adminCreateUnionPid /
// adminUpdateUnionPid / adminActivateUnionPid / adminRetireUnionPid; BR-ATTR-02, BR-ATTR-28).
// Mounted only by UnionAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the JSON bodies before this runs; the operation guard checks the
// account, the permission point union.pid (the list read-only, without step-up) and, on writes, its
// totp step-up, consuming the step-up token only after a 200 with code 0. Refusals are thrown inside
// the guard so a refused change never uses up the token. The activation's multipart body is read
// only inside the guard's callback. No Idempotency-Key (contract): the row_version compare-and-set
// makes a repeat a 20902, and a repeated registration is a duplicate.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
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
  type SingleUploadRequest,
} from '../../../platform/index.ts';
import {
  AdminPidConflictError,
  AdminPidFieldsError,
  AdminPidSceneActiveError,
  AdminUnionPids,
  type AdminPid,
  type AdminPidActor,
} from '../../application/admin-pids.ts';
import { ActivationPartsRejection, readActivationParts } from './activation-parts.ts';

export interface AdminPidRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

type PidResponse = Schema<'AdminUnionPidResponse'>;
type ListResponse = Schema<'AdminUnionPidListResponse'>;

/** specs/permissions.yaml: union.pid, totp tier. */
const PERMISSION = 'union.pid';

export class AdminUnionPidsController {
  readonly #guard: AdminOperationGuard;
  readonly #pids: AdminUnionPids;

  constructor(guard: AdminOperationGuard, pids: AdminUnionPids) {
    this.#guard = guard;
    this.#pids = pids;
  }

  async list(request: AdminPidRequest): Promise<ListResponse> {
    let response: ListResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION, readOnly: true }, async (actor) => {
      const items = await this.#pids.list(actor.appId);
      response = { code: 0, msg: '', data: { items }, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('union: admin guard returned without an answer');
    return response;
  }

  create(request: AdminPidRequest, body: Schema<'AdminUnionPidCreateRequest'>) {
    return this.#write(request, (actor) => this.#pids.create(actor, body));
  }

  update(request: AdminPidRequest, pidId: string, body: Schema<'AdminUnionPidUpdateRequest'>) {
    return this.#write(request, (actor) => this.#pids.update(actor, pidId, body));
  }

  activate(request: AdminPidRequest & SingleUploadRequest, pidId: string) {
    return this.#write(request, async (actor) =>
      this.#pids.activate(actor, pidId, await readActivationParts(request)),
    );
  }

  retire(request: AdminPidRequest, pidId: string, body: Schema<'AdminUnionPidRetireRequest'>) {
    return this.#write(request, (actor) => this.#pids.retire(actor, pidId, body));
  }

  async #write(
    request: AdminPidRequest,
    work: (actor: AdminPidActor) => Promise<AdminPid>,
  ): Promise<PidResponse> {
    let response: PidResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      try {
        const data = await work(actorOf(actor, request));
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) throw new Error('union: admin guard returned without an answer');
    return response;
  }
}

function actorOf(actor: AdminActor, request: AdminPidRequest): AdminPidActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminPidFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof ActivationPartsRejection) {
    const refused = fieldsErrorEnvelope(['body'], traceId);
    return new HttpException(refused.body, error.statusCode);
  }
  if (error instanceof AdminPidConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'union_pid' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof AdminPidSceneActiveError) {
    return new HttpException(
      { code: 30155, msg: '该场景已有启用中的推广位，请先停用', trace_id: traceId },
      422,
    );
  }
  return error;
}

/**
 * The contract schema of adminUpdateUnionPid without the body's `minProperties`: with ajv's
 * allErrors a body lacking `expected_row_version` would also be reported as [body], while the
 * contract answers 20001 [expected_row_version] for it. The empty patch (no editable field) is
 * still refused with 20001 [body], by AdminUnionPids.update (application/admin-pids.ts).
 */
function updateRouteSchema(): ReturnType<typeof contractRouteSchema<'adminUpdateUnionPid'>> {
  const schema = structuredClone(contractRouteSchema('adminUpdateUnionPid'));
  const body = (schema as { body?: Record<string, unknown> }).body;
  if (body !== undefined) delete body['minProperties'];
  return schema;
}

// Plain decorator calls, as linking's and content's admin controllers (no parameter decorators).
{
  const prototype = AdminUnionPidsController.prototype;
  const descriptor = (name: 'list' | 'create' | 'update' | 'activate' | 'retire') =>
    Object.getOwnPropertyDescriptor(prototype, name)!;
  Inject(AdminOperationGuard)(AdminUnionPidsController, undefined, 0);
  Inject(AdminUnionPids)(AdminUnionPidsController, undefined, 1);

  const list = descriptor('list');
  Req()(prototype, 'list', 0);
  Get()(prototype, 'list', list);
  HttpCode(200)(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnionPids'))(prototype, 'list', list);

  const create = descriptor('create');
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Post()(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateUnionPid'))(prototype, 'create', create);

  const update = descriptor('update');
  Req()(prototype, 'update', 0);
  Param('pid_id')(prototype, 'update', 1);
  Body()(prototype, 'update', 2);
  Patch(':pid_id')(prototype, 'update', update);
  HttpCode(200)(prototype, 'update', update);
  RouteSchema(updateRouteSchema())(prototype, 'update', update);

  const activate = descriptor('activate');
  Req()(prototype, 'activate', 0);
  Param('pid_id')(prototype, 'activate', 1);
  Post(':pid_id/activate')(prototype, 'activate', activate);
  HttpCode(200)(prototype, 'activate', activate);
  RouteSchema(contractRouteSchema('adminActivateUnionPid'))(prototype, 'activate', activate);

  const retire = descriptor('retire');
  Req()(prototype, 'retire', 0);
  Param('pid_id')(prototype, 'retire', 1);
  Body()(prototype, 'retire', 2);
  Post(':pid_id/retire')(prototype, 'retire', retire);
  HttpCode(200)(prototype, 'retire', retire);
  RouteSchema(contractRouteSchema('adminRetireUnionPid'))(prototype, 'retire', retire);

  Controller('admin/v1/union-pids')(AdminUnionPidsController);
}
