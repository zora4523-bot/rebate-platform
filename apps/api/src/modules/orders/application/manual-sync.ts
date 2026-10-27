// B1-09i: the console's manual order sync (POST / GET /admin/v1/order-syncs, GET
// /admin/v1/order-syncs/limits; 01 F-ORD-10; 02 §7.1; contract adminCreateOrderSync,
// adminListOrderSyncs, adminGetOrderSyncLimits, CT-24n). The permission check (order.view) is the
// controller's, through platform's AdminOperationGuard; appId and adminId are the guard's actor.
// - create: one order_sync_requests row per filter while it is queued or running (the partial
//   unique index order_sync_requests_live_digest_key decides; an equal request meanwhile returns
//   the original with reused=true and dispatches nothing). A window request is cut into windows of
//   the platform's cap (02 §7.1) and every window goes to the order-sync queue with the key
//   `platform:account:kind:scene:manual:<filter_digest>:window_start`; sync_cursors is neither read
//   nor advanced. An order-number request is Pinduoduo only (union's getPddOrderDetail); taobao / jd
//   are refused with 20001 data.fields=[order_nos]. A status_filter not registered for the platform
//   in specs/union/<platform>.md is 20001 [status_filter]. While the platform's sync stream is
//   paused by the site owner's authorization (BR-ID-24 ④, union's siteAuthAvailable) the request is
//   refused with 30156 data.platform; while the offline breaker is open nothing is dispatched (the
//   breaker is the worker's; the handler re-checks it when it takes each job).
//   The filter_digest in the key carries no request id, so a job left queued by an earlier ended
//   request of the same filter (one failed while its other windows waited) still holds a key and
//   the queue drops the new send (null). Then the whole request is rolled back and the create fails
//   (ManualOrderSyncDispatchDroppedError, 50001): the leftovers are dropped by the worker as their
//   request ended, after which the same filter can be submitted again, instead of a new request
//   whose windows were never queued staying live and holding its filter for good.
//   Every job sent gets a progress row in order_sync_request_windows (same transaction; its index
//   `sync_seq` travels in the payload): the worker ends the request once no row is left queued or
//   running (jobs/manual-sync.ts), whatever order the queue runs them in.
// - list: the app's requests, created_at descending; limits: manualSyncLimits at the Clock.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7, type Clock, type JobQueue } from '../../platform/index.ts';
import { isRegisteredPlatform, type RegisteredPlatform } from '../../union/index.ts';
import {
  MANUAL_SYNC_ORDER_NO_PLATFORMS,
  manualSyncFilterDigest,
  manualSyncLimits,
  manualSyncStatusFilterRegistered,
  manualSyncWindows,
  parseOffsetInstantMs,
  type ManualSyncFilter,
} from '../domain/manual-sync.ts';
import { INCREMENT_WINDOW_CAP_MS, instantAt } from '../domain/sync-window.ts';
import {
  countOrderSyncRequests,
  findLiveOrderSyncRequest,
  insertOrderSyncRequest,
  insertOrderSyncRequestWindows,
  pageOrderSyncRequests,
  type OrderSyncRequestRow,
} from '../infra/order-sync-requests.ts';
import type { SyncAccessPort, SyncAccount, SyncLogger } from './sync-ports.ts';
import { ORDER_SYNC_QUEUE } from './sync-scheduler.ts';

/** Job names of the manual sync on the shared order-sync queue (jobs/manual-sync.ts takes them). */
export const MANUAL_SYNC_WINDOW_JOB = 'manual_window';
export const MANUAL_SYNC_ORDER_NOS_JOB = 'manual_order_nos';
/** query_kind of an order-number job (a window job is 'increment', the scheduler's kind). */
export const MANUAL_SYNC_ORDER_NOS_KIND = 'order_detail';

export interface ManualOrderSyncDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  /** union's sync access (createUnionSyncAccess): accounts, site authorization, offline breaker. */
  readonly access: SyncAccessPort;
  /** admin: admin_id → display name (display_name, else login_name); unknown ids left out. */
  readonly adminNames?: (
    appId: string,
    adminIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** Flat fields only (platform, sync_id, windows); never order numbers. */
  readonly logger?: SyncLogger;
}

/** The admin of the token: the request's app and requested_by. */
export interface ManualOrderSyncRequester {
  readonly appId: string;
  readonly adminId: string;
}

export interface ManualOrderSyncListQuery {
  readonly page?: number;
  readonly page_size?: number;
}

export interface ManualOrderSyncs {
  /** Refusals (20001 with fields, 30156 with platform) reject; nothing is written or sent then. */
  create(
    requester: ManualOrderSyncRequester,
    body: Schema<'AdminOrderSyncCreateRequest'>,
  ): Promise<Schema<'AdminOrderSyncCreated'>>;
  list(appId: string, query: ManualOrderSyncListQuery): Promise<Schema<'AdminOrderSyncPage'>>;
  limits(): Schema<'AdminOrderSyncLimits'>;
}

/** 20001 with data.fields. */
export class ManualOrderSyncFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super('orders: manual sync refused');
    this.name = 'ManualOrderSyncFieldsError';
    this.fields = fields;
  }
}

/** 30156 with data.platform: the platform's sync stream is paused by the site authorization. */
export class ManualOrderSyncPausedError extends Error {
  readonly platform: RegisteredPlatform;
  constructor(platform: RegisteredPlatform) {
    super('orders: manual sync paused by site authorization');
    this.name = 'ManualOrderSyncPausedError';
    this.platform = platform;
  }
}

/** A window or order-number send was dropped by the queue (its key still held by a leftover job). */
export class ManualOrderSyncDispatchDroppedError extends Error {
  constructor() {
    super('orders: manual sync job dropped by the queue, a job of the same key is still queued');
    this.name = 'ManualOrderSyncDispatchDroppedError';
  }
}

const DEFAULT_PAGE_SIZE = 20;

type Body = Record<string, unknown>;

/** The checks of the handler after the route schema (which already rejected shapes and enums). */
function parseFilter(body: Body, now: Date): ManualSyncFilter {
  const hasWindow = 'from' in body || 'to' in body || 'status_filter' in body;
  const hasNumbers = 'order_nos' in body;
  if (hasWindow === hasNumbers) {
    throw new ManualOrderSyncFieldsError(hasWindow ? ['order_nos'] : ['from', 'to', 'order_nos']);
  }
  const platform = body['platform'];
  if (typeof platform !== 'string' || !isRegisteredPlatform(platform)) {
    throw new ManualOrderSyncFieldsError(['platform']);
  }
  if (hasNumbers) {
    const numbers = body['order_nos'];
    const limit = manualSyncLimits(now).find((item) => item.platform === platform);
    if (
      !Array.isArray(numbers) ||
      numbers.length === 0 ||
      numbers.some((n) => typeof n !== 'string' || n === '' || n.length > 64) ||
      // TODO(规划/11 §4.5): 淘宝 / 京东按单号同步 — blocked on CAP-TB-07 / CAP-JD-07
      !MANUAL_SYNC_ORDER_NO_PLATFORMS.includes(platform) ||
      limit === undefined ||
      numbers.length > limit.max_order_nos
    ) {
      throw new ManualOrderSyncFieldsError(['order_nos']);
    }
    return { platform, mode: 'order_nos', order_nos: numbers as string[] };
  }
  const fromMs = parseOffsetInstantMs(body['from']);
  const toMs = parseOffsetInstantMs(body['to']);
  const invalid = [...(fromMs === null ? ['from'] : []), ...(toMs === null ? ['to'] : [])];
  if (invalid.length > 0) throw new ManualOrderSyncFieldsError(invalid);
  const statusFilter = body['status_filter'] ?? null;
  if (
    statusFilter !== null &&
    (typeof statusFilter !== 'string' || !manualSyncStatusFilterRegistered(platform, statusFilter))
  ) {
    throw new ManualOrderSyncFieldsError(['status_filter']);
  }
  const limit = manualSyncLimits(now).find((item) => item.platform === platform);
  if (limit === undefined) throw new ManualOrderSyncFieldsError(['platform']);
  if (fromMs! >= toMs!) throw new ManualOrderSyncFieldsError(['from', 'to']);
  if (fromMs! < Date.parse(limit.earliest_from)) throw new ManualOrderSyncFieldsError(['from']);
  return {
    platform,
    mode: 'window',
    from: body['from'] as string,
    to: body['to'] as string,
    status_filter: statusFilter,
  };
}

function created(row: OrderSyncRequestRow, reused: boolean): Schema<'AdminOrderSyncCreated'> {
  return {
    sync_id: row.id,
    status: row.status as Schema<'AdminOrderSyncCreated'>['status'],
    reused,
    created_at: row.created_at.toISOString(),
  };
}

export function createManualOrderSyncs(deps: ManualOrderSyncDeps): ManualOrderSyncs {
  const { db, clock, queue, access, logger } = deps;

  /** The app's union accounts of the platform (the worker applies the D10-36 account filter). */
  async function accountsOf(appId: string, platform: RegisteredPlatform) {
    const all = await access.listEnabledAccounts();
    return all.filter((a) => a.app_id === appId && a.platform === platform);
  }

  async function dispatch(
    trx: Transaction<DB>,
    row: OrderSyncRequestRow,
    filter: ManualSyncFilter,
    accounts: readonly SyncAccount[],
  ): Promise<number> {
    const now = clock.now();
    const jobs: {
      name: string;
      payload: Record<string, unknown>;
      key: string;
      account: string;
      window: { start: Date; end: Date } | null;
    }[] = [];
    for (const account of accounts) {
      const stream = {
        app_id: account.app_id,
        platform: account.platform,
        union_account_id: account.union_account_id,
        scene: '-',
      };
      if (filter.mode === 'order_nos') {
        jobs.push({
          name: MANUAL_SYNC_ORDER_NOS_JOB,
          payload: {
            ...stream,
            query_kind: MANUAL_SYNC_ORDER_NOS_KIND,
            sync_id: row.id,
            order_nos: [...filter.order_nos],
          },
          key: [
            account.platform,
            account.union_account_id,
            MANUAL_SYNC_ORDER_NOS_KIND,
            '-',
            'manual',
            row.filter_digest,
            'order_nos',
          ].join(':'),
          account: account.union_account_id,
          window: null,
        });
        continue;
      }
      const cap = INCREMENT_WINDOW_CAP_MS[account.platform]!;
      const windows = manualSyncWindows(
        row.from!.getTime(),
        row.to!.getTime(),
        cap,
        instantAt(now, row.from!.getTime()),
      );
      for (const win of windows) {
        jobs.push({
          name: MANUAL_SYNC_WINDOW_JOB,
          payload: { ...stream, query_kind: 'increment', ...win, sync_id: row.id },
          key: [
            account.platform,
            account.union_account_id,
            'increment',
            '-',
            'manual',
            row.filter_digest,
            win.window_start,
          ].join(':'),
          account: account.union_account_id,
          window: {
            start: instantAt(now, Date.parse(win.window_start)),
            end: instantAt(now, Date.parse(win.window_end)),
          },
        });
      }
    }
    await insertOrderSyncRequestWindows(
      trx,
      row,
      jobs.map((job, seq) => ({
        seq,
        union_account_id: job.account,
        window_start: job.window?.start ?? null,
        window_end: job.window?.end ?? null,
      })),
    );
    for (const [i, job] of jobs.entries()) {
      const id = await queue.send(
        ORDER_SYNC_QUEUE,
        job.name,
        { ...(job.payload as Record<string, never>), sync_seq: i },
        { trx, singletonKey: job.key },
      );
      if (id === null) {
        logger?.warn(
          { platform: row.platform, sync_id: row.id, jobs: jobs.length, dropped_at: i },
          'order_manual_sync_dispatch_dropped',
        );
        throw new ManualOrderSyncDispatchDroppedError();
      }
    }
    return jobs.length;
  }

  return {
    async create(requester, body) {
      const now = clock.now();
      const filter = parseFilter(body as unknown as Body, now);
      const accounts = await accountsOf(requester.appId, filter.platform);
      // No union account of the platform in this app: there is no stream to sync.
      if (accounts.length === 0) throw new ManualOrderSyncFieldsError(['platform']);
      // BR-ID-24 ④: the platform's stream is paused while any of its accounts lacks site auth.
      for (const account of accounts) {
        if (!(await access.siteAuthAvailable(account))) {
          logger?.info({ platform: filter.platform }, 'order_manual_sync_paused_site_auth');
          throw new ManualOrderSyncPausedError(filter.platform);
        }
      }
      const digest = manualSyncFilterDigest(filter);
      const live = await findLiveOrderSyncRequest(db, requester.appId, digest);
      if (live !== null) return created(live, true);
      const circuitOpen = await access.offlineCircuitOpen(filter.platform);
      const row = {
        id: newUuidV7(now),
        app_id: requester.appId,
        platform: filter.platform,
        mode: filter.mode,
        from: filter.mode === 'window' ? instantAt(now, parseOffsetInstantMs(filter.from)!) : null,
        to: filter.mode === 'window' ? instantAt(now, parseOffsetInstantMs(filter.to)!) : null,
        status_filter: filter.mode === 'window' ? filter.status_filter : null,
        order_nos: filter.mode === 'order_nos' ? filter.order_nos : null,
        filter_digest: digest,
        requested_by: requester.adminId,
        created_at: now,
      } as const;
      for (;;) {
        const result = await db.transaction().execute(async (trx) => {
          const inserted = await insertOrderSyncRequest(trx, row);
          if (inserted === null) return null;
          if (circuitOpen) {
            // 02 §6.2: nothing is dispatched while the platform's offline breaker is open; the
            // request ends at once so the filter is free again.
            const failed = await trx
              .withSchema('app')
              .updateTable('order_sync_requests')
              .set({ status: 'failed', error: 'offline_circuit_open', finished_at: now })
              .where('id', '=', inserted.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            return { row: failed, jobs: 0 };
          }
          return { row: inserted, jobs: await dispatch(trx, inserted, filter, accounts) };
        });
        if (result !== null) {
          logger?.info(
            {
              platform: filter.platform,
              sync_id: result.row.id,
              mode: filter.mode,
              jobs: result.jobs,
              circuit_open: circuitOpen,
            },
            'order_manual_sync_created',
          );
          return created(result.row, false);
        }
        // An equal request committed meanwhile; it may also have ended already, then retry.
        const winner = await findLiveOrderSyncRequest(db, requester.appId, digest);
        if (winner !== null) return created(winner, true);
      }
    },

    async list(appId, query) {
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
      const total = await countOrderSyncRequests(db, appId);
      const offset = (page - 1) * pageSize;
      const rows = offset >= total ? [] : await pageOrderSyncRequests(db, appId, offset, pageSize);
      const ids = [...new Set(rows.map((r) => r.requested_by))];
      const names =
        ids.length === 0 || deps.adminNames === undefined
          ? new Map<string, string>()
          : await deps.adminNames(appId, ids);
      return {
        items: rows.map((r) => ({
          sync_id: r.id,
          platform: r.platform as Schema<'AdminOrderSyncListItem'>['platform'],
          mode: r.mode as Schema<'AdminOrderSyncListItem'>['mode'],
          from: r.from?.toISOString() ?? null,
          to: r.to?.toISOString() ?? null,
          status_filter: r.status_filter,
          order_nos: r.order_nos,
          status: r.status as Schema<'AdminOrderSyncListItem'>['status'],
          requested_by: r.requested_by,
          requested_by_name: names.get(r.requested_by) ?? null,
          fetched_count: r.fetched_count,
          stored_count: r.stored_count,
          created_at: r.created_at.toISOString(),
          finished_at: r.finished_at?.toISOString() ?? null,
        })),
        page,
        page_size: pageSize,
        total,
      };
    },

    limits() {
      return { items: manualSyncLimits(clock.now()).map((item) => ({ ...item })) };
    },
  };
}
