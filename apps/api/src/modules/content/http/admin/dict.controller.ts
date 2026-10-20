import { Controller, Get, HttpCode, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { admin_permission, type Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type AdminOperationInput,
  type CheckedRequest,
} from '../../../platform/index.ts';
import { AdminDictReader } from '../../application/admin-dict-reader.ts';

interface AdminDictRequest extends CheckedRequest {
  readonly id: string;
}

/**
 * Any one permission point of specs/permissions.yaml (04 §6.6 `dict`): every signed-in console
 * account holding at least one point may read; read only, so no step-up is read or consumed.
 * The list comes from the generated contract enum (content does not import admin).
 */
const READ_ACCESS: Pick<AdminOperationInput, 'permission' | 'readOnly'> = {
  permission: admin_permission,
  readOnly: true,
};

/**
 * GET /admin/v1/dict (F1-02zd; contract adminGetDict), mounted on the admin entry only. The app
 * is the verified account's; reads are not audited.
 */
export class AdminDictController {
  readonly #guard: AdminOperationGuard;
  readonly #reader: AdminDictReader;

  constructor(guard: AdminOperationGuard, reader: AdminDictReader) {
    this.#guard = guard;
    this.#reader = reader;
  }

  async read(request: AdminDictRequest): Promise<Schema<'AdminDictResponse'>> {
    let response: Schema<'AdminDictResponse'> | undefined;
    await this.#guard.run({ request, ...READ_ACCESS }, async (actor) => {
      const data = await this.#reader.read(actor.appId);
      response = { code: 0, msg: '', data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('content: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls also compile in the test project's erasable-syntax mode.
{
  const prototype = AdminDictController.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Inject(AdminOperationGuard)(AdminDictController, undefined, 0);
  Inject(AdminDictReader)(AdminDictController, undefined, 1);
  Req()(prototype, 'read', 0);
  Get()(prototype, 'read', read);
  HttpCode(200)(prototype, 'read', read);
  RouteSchema(contractRouteSchema('adminGetDict'))(prototype, 'read', read);
  Controller('admin/v1/dict')(AdminDictController);
}
