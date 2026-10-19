import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminOperationInput,
  type CheckedRequest,
  type ContractOperationId,
} from '../../../platform/index.ts';
import {
  DictConflictError,
  DictFieldsError,
  DictItemAdmin,
  type DictHistoryQuery,
  type DictItemActor,
  type DictKeyClass,
  type DictListQuery,
} from '../../application/dict-item-admin.ts';
import { DICT_READ_PERMISSIONS, dictPermissionOf } from '../../domain/dict/index.ts';

interface DictItemRequest extends CheckedRequest {
  readonly id: string;
  readonly ip?: string;
}

type Access = Pick<AdminOperationInput, 'permission' | 'readOnly'>;
type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

const READ_ACCESS: Access = { permission: DICT_READ_PERMISSIONS, readOnly: true };
/** Guard refusals that BR-TEXT-12 细则「写入口统一」 records for fund term keys. */
const DENIAL_CODES = new Set([10403, 10003]);

function ipOf(request: DictItemRequest): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}

function denialCode(error: unknown): number | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  const code =
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'number' && DENIAL_CODES.has(code) ? code : null;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException(refused.body, refused.statusCode);
}

/**
 * /admin/v1/dict-items* (F1-02t), mounted on the admin entry only. Writes pick their permission
 * point from the class of their keys before the guard runs (one class per request, L12 / L38):
 * general → config.general; fund_terms → content.fund_terms (totp); agreement →
 * content.agreement (totp). A fund term write the guard refuses is audited with its keys.
 */
export class AdminDictItemsController {
  readonly #guard: AdminOperationGuard;
  readonly #dict: DictItemAdmin;

  constructor(guard: AdminOperationGuard, dict: DictItemAdmin) {
    this.#guard = guard;
    this.#dict = dict;
  }

  list(
    request: DictItemRequest,
    query: DictListQuery,
  ): Promise<Schema<'AdminDictItemPageResponse'>> {
    return this.#run(request, READ_ACCESS, (actor) => this.#dict.list(actor.appId, query ?? {}));
  }

  history(
    request: DictItemRequest,
    query: DictHistoryQuery,
  ): Promise<Schema<'AdminDictItemVersionPageResponse'>> {
    return this.#run(request, READ_ACCESS, (actor) => this.#dict.history(actor.appId, query ?? {}));
  }

  save(
    request: DictItemRequest,
    body: Schema<'AdminDictSaveRequest'>,
  ): Promise<Schema<'AdminDictSaveResultResponse'>> {
    const keys = body.changes.map((change) => change.key);
    return this.#write(request, 'save', keys, 'changes', (actor) => this.#dict.save(actor, body));
  }

  rollback(
    request: DictItemRequest,
    body: Schema<'AdminDictRollbackRequest'>,
  ): Promise<Schema<'AdminDictSaveResultResponse'>> {
    return this.#write(request, 'rollback', body.keys, 'keys', (actor) =>
      this.#dict.rollback(actor, body),
    );
  }

  async #write<T>(
    request: DictItemRequest,
    operation: 'save' | 'rollback',
    keys: readonly string[],
    field: 'changes' | 'keys',
    work: (actor: DictItemActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let keyClass: DictKeyClass;
    try {
      keyClass = this.#dict.requestClass(keys, field);
    } catch (error) {
      if (error instanceof DictFieldsError) throw fieldsRefusal(error.fields, request.id);
      throw error;
    }
    try {
      return await this.#run(request, { permission: dictPermissionOf(keyClass) }, work);
    } catch (error) {
      const code = denialCode(error);
      const principal = adminPrincipal(request);
      if (keyClass === 'fund_terms' && code !== null && principal !== undefined) {
        // The verified token's account: refused before any business read, nothing was saved.
        await this.#dict.denied(
          { appId: principal.appId, adminId: principal.adminId, ip: ipOf(request) },
          operation,
          keys,
          code,
        );
      }
      throw error;
    }
  }

  async #run<T>(
    request: DictItemRequest,
    access: Access,
    work: (actor: DictItemActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    try {
      await this.#guard.run({ request, ...access }, async (actor) => {
        const data = await work({
          appId: actor.appId,
          adminId: actor.adminId,
          loginName: actor.loginName,
          ip: ipOf(request),
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      });
    } catch (error) {
      // Rejections throw through the guard, so a failed write never consumes the step-up token.
      if (error instanceof DictFieldsError) throw fieldsRefusal(error.fields, request.id);
      if (error instanceof DictConflictError) {
        throw new HttpException(
          {
            code: 20902,
            msg: '状态已变化，请刷新后重试',
            data: { resource: 'dict_item' },
            trace_id: request.id,
          },
          409,
        );
      }
      throw error;
    }
    if (response === undefined) throw new Error('content: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls also compile in the test project's erasable-syntax mode.
{
  const prototype = AdminDictItemsController.prototype;
  Inject(AdminOperationGuard)(AdminDictItemsController, undefined, 0);
  Inject(DictItemAdmin)(AdminDictItemsController, undefined, 1);
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Req()(prototype, 'history', 0);
  Query()(prototype, 'history', 1);
  Req()(prototype, 'save', 0);
  Body()(prototype, 'save', 1);
  Req()(prototype, 'rollback', 0);
  Body()(prototype, 'rollback', 1);

  const routes = [
    ['list', Get(), 'adminListDictItems'],
    ['history', Get('versions'), 'adminListDictItemVersions'],
    ['save', Put(), 'adminSaveDictItems'],
    ['rollback', Post('rollback'), 'adminRollbackDictItems'],
  ] as const;
  for (const [method, route, operation] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    route(prototype, method, descriptor);
    HttpCode(200)(prototype, method, descriptor);
    RouteSchema(contractRouteSchema(operation as ContractOperationId))(
      prototype,
      method,
      descriptor,
    );
  }
  Controller('admin/v1/dict-items')(AdminDictItemsController);
}
