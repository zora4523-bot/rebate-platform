// B2-09e: GET /admin/v1/asset-snapshots (listAdminAssetSnapshots, CT-24zb; 08 BR-FUND-18; 04 §3.2
// asset_snapshots, asset_snapshot_receivables, §11.1, §11.2). Only authorisation, the parameters
// and the call into application/ live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the query (date_from / date_to as dates,
// page_size ≤ 200) before this runs. The AdminOperationGuard re-reads the account and checks the
// permission point fund.view, read only (no step-up). A super admin holds every point. The range
// refusal (20001 data.fields) is thrown as an error envelope for the global filter. Answers are
// no-store; reading writes no audit record and never writes a snapshot.
// Without the database (isolated HTTP unit tests) the route still registers and every call fails
// closed (50001).
import { Controller, Get, HttpException, Inject, Query, Req, Res } from '@nestjs/common';
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
  AssetSnapshotFieldsError,
  listAdminAssetSnapshots,
  type AssetSnapshotListQuery,
} from '../../application/admin-asset-snapshots.ts';

/** Nest token of the handle the read runs on (null in a process without database). */
export const ASSET_SNAPSHOT_READ_DB = Symbol('LEDGER_ASSET_SNAPSHOT_READ_DB');

/** specs/permissions.yaml: fund.view (step-up null). */
const READ = ['fund.view'] as const;

export interface AdminAssetSnapshotsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminAssetSnapshotsController {
  readonly #guard: AdminOperationGuard;
  readonly #db: Kysely<Database> | null;

  constructor(guard: AdminOperationGuard, db: Kysely<Database> | null) {
    this.#guard = guard;
    this.#db = db;
  }

  async list(
    request: AdminAssetSnapshotsRequest,
    query: AssetSnapshotListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAssetSnapshotPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminAssetSnapshotPageResponse'> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const db = this.#db;
      if (db === null) throw new Error('ledger: admin asset snapshot reads need the database');
      try {
        response = {
          code: 0,
          msg: '',
          data: await listAdminAssetSnapshots(db, actor.appId, query),
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AssetSnapshotFieldsError) {
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
  const prototype = AdminAssetSnapshotsController.prototype;
  Inject(AdminOperationGuard)(AdminAssetSnapshotsController, undefined, 0);
  Inject(ASSET_SNAPSHOT_READ_DB)(AdminAssetSnapshotsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('asset-snapshots')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminAssetSnapshots'))(prototype, 'list', list);

  Controller('admin/v1')(AdminAssetSnapshotsController);
}
