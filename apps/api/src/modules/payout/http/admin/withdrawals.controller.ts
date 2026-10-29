// B2-09c: GET /admin/v1/withdrawals and GET /admin/v1/withdrawals/{withdrawal_id}
// (listAdminWithdrawals, getAdminWithdrawal; 08 BR-WDR-10 细则 审核列表与详情; 04 §3.2, §11.1,
// §11.2). Only authorisation, the parameters and the call into application/ live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the query and the path before this runs. The
// AdminOperationGuard re-reads the account and checks the permission point: any one of
// withdraw.review or fund.view, read only (no step-up). A super admin holds every point. Refusals
// of the reads (20001 data.fields) are thrown as error envelopes for the global filter. Answers
// are no-store; reading writes no audit record. Without the database (isolated HTTP unit tests)
// the routes still register and every call fails closed (50001).
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
  AdminWithdrawalFieldsError,
  getAdminWithdrawal,
  listAdminWithdrawals,
  type AdminWithdrawalListQuery,
  type AdminWithdrawalReadDeps,
} from '../../application/admin-withdrawals.ts';

/** Nest token of the read dependencies (null in a process without database). */
export const ADMIN_WITHDRAWAL_READS = Symbol('PAYOUT_ADMIN_WITHDRAWAL_READS');

/** specs/permissions.yaml: withdraw.review, fund.view (both step-up null); either one suffices. */
const READ = ['withdraw.review', 'fund.view'] as const;

export interface AdminWithdrawalsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

export class AdminWithdrawalsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminWithdrawalReadDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminWithdrawalReadDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  list(
    request: AdminWithdrawalsRequest,
    query: AdminWithdrawalListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminWithdrawalPageResponse'>> {
    return this.#read(request, reply, (deps, appId) => listAdminWithdrawals(deps, appId, query));
  }

  detail(
    request: AdminWithdrawalsRequest,
    withdrawalId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminWithdrawalDetailResponse'>> {
    return this.#read(request, reply, (deps, appId) =>
      getAdminWithdrawal(deps, appId, withdrawalId),
    );
  }

  async #read<T>(
    request: AdminWithdrawalsRequest,
    reply: HeaderReply,
    read: (deps: AdminWithdrawalReadDeps, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('payout: admin withdrawal reads need the database');
      try {
        response = { code: 0, msg: '', data: await read(deps, actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminWithdrawalFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('payout: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminWithdrawalsController.prototype;
  Inject(AdminOperationGuard)(AdminWithdrawalsController, undefined, 0);
  Inject(ADMIN_WITHDRAWAL_READS)(AdminWithdrawalsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('withdrawals')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminWithdrawals'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('withdrawal_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('withdrawals/:withdrawal_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminWithdrawal'))(prototype, 'detail', detail);

  Controller('admin/v1')(AdminWithdrawalsController);
}
