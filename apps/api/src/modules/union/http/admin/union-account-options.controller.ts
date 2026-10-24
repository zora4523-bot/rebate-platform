// GET /admin/v1/union/account-options (B1-22o; adminListUnionAccountOptions, D10-243; BR-ATTR-02
// 细则「后台登记与启停」, 04 §6.6, §11.2). Mounted only by UnionAdminModule on the admin entry, as
// union-pids.controller.ts. The admin request check has verified the admin_token and the route
// schema the query (a platform outside enum platform is 20001 [platform]) before this runs;
// AdminOperationGuard checks the account and the permission point union.pid or
// union.account_auth (either is enough), read only without step-up. Writes no audit row.
import { Controller, Get, HttpCode, Inject, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { AdminOperationGuard, contractRouteSchema } from '../../../platform/index.ts';
import {
  AdminUnionAccountOptions,
  type AdminUnionAccountOption,
} from '../../application/admin-account-options.ts';
import type { AdminUnionAccountRequest } from './union-accounts.controller.ts';

/** Query as the route schema delivers it. */
export interface AdminUnionAccountOptionsQuery {
  readonly platform?: AdminUnionAccountOption['platform'];
}

/** specs/permissions.yaml: either point reads the choices (contract, D10-243). */
const PERMISSIONS = ['union.pid', 'union.account_auth'] as const;

type OptionsResponse = Schema<'AdminUnionAccountOptionListResponse'>;

export class AdminUnionAccountOptionsController {
  readonly #guard: AdminOperationGuard;
  readonly #options: AdminUnionAccountOptions;

  constructor(guard: AdminOperationGuard, options: AdminUnionAccountOptions) {
    this.#guard = guard;
    this.#options = options;
  }

  async list(
    request: AdminUnionAccountRequest,
    query: AdminUnionAccountOptionsQuery | undefined,
  ): Promise<OptionsResponse> {
    let response: OptionsResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSIONS, readOnly: true }, async (actor) => {
      const items = await this.#options.list({
        appId: actor.appId,
        platform: query?.platform,
      });
      response = { code: 0, msg: '', data: { items }, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('union: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as union-accounts.controller.ts (no parameter decorators).
{
  const prototype = AdminUnionAccountOptionsController.prototype;
  Inject(AdminOperationGuard)(AdminUnionAccountOptionsController, undefined, 0);
  Inject(AdminUnionAccountOptions)(AdminUnionAccountOptionsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Get()(prototype, 'list', list);
  HttpCode(200)(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnionAccountOptions'))(prototype, 'list', list);

  Controller('admin/v1/union/account-options')(AdminUnionAccountOptionsController);
}
