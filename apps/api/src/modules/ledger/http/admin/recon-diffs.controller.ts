// B2-09a: GET /admin/v1/recon-diffs and GET /admin/v1/recon-diffs/{recon_diff_id}
// (listAdminReconDiffs, getAdminReconDiff; 08 BR-FUND-22 差错单; 04 §3.2, §11.1, §11.2). Only
// authorisation, the parameters and the call into application/ live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the query and the path before this runs. The
// AdminOperationGuard re-reads the account and checks the permission point: any one of fund.recon
// or fund.view, read only (no step-up; an X-Step-Up-Token header is neither read nor consumed). A
// super admin holds every point. Refusals of the reads (20001 data.fields) are thrown as error
// envelopes for the global filter. Answers are no-store; reading writes no audit record.
// Without the database (isolated HTTP unit tests) the routes still register and every call fails
// closed (50001).
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  ReconDiffFieldsError,
  getAdminReconDiff,
  listAdminReconDiffs,
  type ReconDiffListQuery,
} from '../../application/admin-recon-diffs.ts';

/** Nest token of the handle the reads run on (null in a process without database). */
export const RECON_DIFF_READ_DB = Symbol('LEDGER_RECON_DIFF_READ_DB');

/** specs/permissions.yaml: fund.recon, fund.view (both step-up null); either one suffices. */
const READ = ['fund.recon', 'fund.view'] as const;

export interface AdminReconDiffsRequest extends CheckedRequest {
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

export class AdminReconDiffsController {
  readonly #guard: AdminOperationGuard;
  readonly #db: Kysely<Database> | null;

  constructor(guard: AdminOperationGuard, db: Kysely<Database> | null) {
    this.#guard = guard;
    this.#db = db;
  }

  list(
    request: AdminReconDiffsRequest,
    query: ReconDiffListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminReconDiffPageResponse'>> {
    return this.#read(request, reply, (db, appId) => listAdminReconDiffs(db, appId, query));
  }

  detail(
    request: AdminReconDiffsRequest,
    reconDiffId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminReconDiffDetailResponse'>> {
    return this.#read(request, reply, (db, appId) => getAdminReconDiff(db, appId, reconDiffId));
  }

  async #read<T>(
    request: AdminReconDiffsRequest,
    reply: HeaderReply,
    read: (db: Kysely<Database>, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const db = this.#db;
      if (db === null) throw new Error('ledger: admin recon diff reads need the database');
      try {
        response = { code: 0, msg: '', data: await read(db, actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof ReconDiffFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('ledger: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminReconDiffsController.prototype;
  Inject(AdminOperationGuard)(AdminReconDiffsController, undefined, 0);
  Inject(RECON_DIFF_READ_DB)(AdminReconDiffsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('recon-diffs')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminReconDiffs'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('recon_diff_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('recon-diffs/:recon_diff_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminReconDiff'))(prototype, 'detail', detail);

  Controller('admin/v1')(AdminReconDiffsController);
}
