// B2-09d: GET /admin/v1/settle-bills, GET /admin/v1/settle-bills/{bill_id} and
// GET /admin/v1/settle-batches/{batch_id}/items (listAdminSettleBills, getAdminSettleBill,
// listAdminSettleBatchItems; 08 BR-FUND-04 细则「月结账单状态」; 04 §3.2, §11.1, §11.2). Only
// authorisation, the parameters and the call into application/ live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the query and the path before this runs. The
// AdminOperationGuard re-reads the account and checks the permission point: any one of
// settle.bill or fund.view, read only (no step-up). A super admin holds every point. Refusals of
// the reads (20001 data.fields) are thrown as error envelopes for the global filter. Answers are
// no-store; reading writes no audit record. Without the database (isolated HTTP unit tests) the
// routes still register and every call fails closed (50001).
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
  AdminSettleBillFieldsError,
  getAdminSettleBill,
  listAdminSettleBatchItems,
  listAdminSettleBills,
  type AdminSettleBatchItemListQuery,
  type AdminSettleBillListQuery,
  type AdminSettleBillReadDeps,
} from '../../application/admin-settle-bills.ts';

/** Nest token of the read dependencies (null in a process without database). */
export const ADMIN_SETTLE_BILL_READS = Symbol('SETTLEMENT_ADMIN_SETTLE_BILL_READS');

/** specs/permissions.yaml: settle.bill, fund.view (both step-up null); either one suffices. */
const READ = ['settle.bill', 'fund.view'] as const;

export interface AdminSettleBillsRequest extends CheckedRequest {
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

export class AdminSettleBillsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminSettleBillReadDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminSettleBillReadDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  list(
    request: AdminSettleBillsRequest,
    query: AdminSettleBillListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminSettleBillPageResponse'>> {
    return this.#read(request, reply, (deps, appId) => listAdminSettleBills(deps, appId, query));
  }

  detail(
    request: AdminSettleBillsRequest,
    billId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminSettleBillDetailResponse'>> {
    return this.#read(request, reply, (deps, appId) => getAdminSettleBill(deps, appId, billId));
  }

  items(
    request: AdminSettleBillsRequest,
    batchId: string,
    query: AdminSettleBatchItemListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminSettleBatchItemPageResponse'>> {
    return this.#read(request, reply, (deps, appId) =>
      listAdminSettleBatchItems(deps, appId, batchId, query),
    );
  }

  async #read<T>(
    request: AdminSettleBillsRequest,
    reply: HeaderReply,
    read: (deps: AdminSettleBillReadDeps, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('settlement: admin settle bill reads need the database');
      try {
        response = { code: 0, msg: '', data: await read(deps, actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminSettleBillFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) {
      throw new Error('settlement: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminSettleBillsController.prototype;
  Inject(AdminOperationGuard)(AdminSettleBillsController, undefined, 0);
  Inject(ADMIN_SETTLE_BILL_READS)(AdminSettleBillsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('settle-bills')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminSettleBills'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('bill_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('settle-bills/:bill_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminSettleBill'))(prototype, 'detail', detail);

  const items = Object.getOwnPropertyDescriptor(prototype, 'items')!;
  Req()(prototype, 'items', 0);
  Param('batch_id')(prototype, 'items', 1);
  Query()(prototype, 'items', 2);
  Res({ passthrough: true })(prototype, 'items', 3);
  Get('settle-batches/:batch_id/items')(prototype, 'items', items);
  RouteSchema(contractRouteSchema('listAdminSettleBatchItems'))(prototype, 'items', items);

  Controller('admin/v1')(AdminSettleBillsController);
}
