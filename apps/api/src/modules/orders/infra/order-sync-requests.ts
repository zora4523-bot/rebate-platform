// B1-09i: app.order_sync_requests, the console's manual sync requests (04 §3.2; migration 0084),
// and app.order_sync_request_windows, one progress row per job a request dispatched (migration
// 0089). orders is the only writer: the admin entry inserts the request (one live row per
// (app_id, filter_digest) while queued or running, the partial unique index
// order_sync_requests_live_digest_key) and its job rows in the same transaction as the queue sends;
// the worker's order-sync handler updates only the granted progress columns. Every status change is
// a compare-and-set on the current status: a job row ends once (queued / running → done / failed),
// so a redelivered job counts nothing twice, and the request's counts are the sum of its rows.
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { manualSyncRequestAfterJob } from '../domain/manual-sync.ts';

export type OrderSyncRequestRow = Selectable<DB['order_sync_requests']>;

/** One job the request dispatched: its index, account and window (null for order numbers). */
export interface NewOrderSyncRequestWindow {
  readonly seq: number;
  readonly union_account_id: string;
  readonly window_start: Date | null;
  readonly window_end: Date | null;
}

export interface NewOrderSyncRequest {
  readonly id: string;
  readonly app_id: string;
  readonly platform: string;
  readonly mode: 'window' | 'order_nos';
  readonly from: Date | null;
  readonly to: Date | null;
  readonly status_filter: string | null;
  readonly order_nos: readonly string[] | null;
  readonly filter_digest: string;
  readonly requested_by: string;
  readonly created_at: Date;
}

const LIVE = ['queued', 'running'] as const;

/** Inserts the request unless an equal one is live; null when the live row won. */
export async function insertOrderSyncRequest(
  trx: Transaction<DB> | Kysely<DB>,
  row: NewOrderSyncRequest,
): Promise<OrderSyncRequestRow | null> {
  const inserted = await trx
    .withSchema('app')
    .insertInto('order_sync_requests')
    .values({
      ...row,
      order_nos: row.order_nos === null ? null : [...row.order_nos],
      status: 'queued',
      fetched_count: 0,
      stored_count: 0,
      error: null,
      finished_at: null,
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'filter_digest']).where('status', 'in', LIVE).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  return inserted ?? null;
}

/** The request's job rows, all queued, in the transaction that inserted the request. */
export async function insertOrderSyncRequestWindows(
  trx: Transaction<DB>,
  request: { readonly app_id: string; readonly id: string; readonly created_at: Date },
  windows: readonly NewOrderSyncRequestWindow[],
): Promise<void> {
  if (windows.length === 0) return;
  await trx
    .withSchema('app')
    .insertInto('order_sync_request_windows')
    .values(
      windows.map((w) => ({
        app_id: request.app_id,
        sync_id: request.id,
        seq: w.seq,
        union_account_id: w.union_account_id,
        window_start: w.window_start,
        window_end: w.window_end,
        status: 'queued',
        fetched_count: 0,
        stored_count: 0,
        error: null,
        finished_at: null,
        created_at: request.created_at,
        updated_at: request.created_at,
      })),
    )
    .execute();
}

/** The queued or running request of this filter, if any. */
export async function findLiveOrderSyncRequest(
  db: Kysely<DB>,
  appId: string,
  digest: string,
): Promise<OrderSyncRequestRow | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('order_sync_requests')
    .selectAll()
    .where('app_id', '=', appId)
    .where('filter_digest', '=', digest)
    .where('status', 'in', LIVE)
    .executeTakeFirst();
  return row ?? null;
}

export async function countOrderSyncRequests(db: Kysely<DB>, appId: string): Promise<number> {
  const row = await db
    .withSchema('app')
    .selectFrom('order_sync_requests')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('app_id', '=', appId)
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

/** created_at descending, then id descending for the same time. */
export async function pageOrderSyncRequests(
  db: Kysely<DB>,
  appId: string,
  offset: number,
  limit: number,
): Promise<readonly OrderSyncRequestRow[]> {
  return db
    .withSchema('app')
    .selectFrom('order_sync_requests')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(offset)
    .limit(limit)
    .execute();
}

/** How one job ended. */
export type OrderSyncJobOutcome =
  | { readonly status: 'done'; readonly fetched: number; readonly stored: number }
  | { readonly status: 'failed'; readonly error: string };

/** The worker side: progress of one request and its job rows. */
export interface OrderSyncRequestProgress {
  /** The request's status, or null when no row of (app_id, id) exists. */
  status(appId: string, id: string): Promise<string | null>;
  /** queued → running for the request and the job row `seq`; anything else is left as it is. */
  start(appId: string, id: string, seq: number): Promise<void>;
  /**
   * Ends the job row `seq` (queued / running → done with its counts, or failed with the error) and
   * then the request: its counts become the sum of its rows; it is failed (the row's error,
   * finished_at at the Clock) once a row failed, done once no row is queued or running, running
   * otherwise. A row already ended (a redelivered job) changes nothing; an ended request keeps its
   * status and counts.
   */
  finish(appId: string, id: string, seq: number, outcome: OrderSyncJobOutcome): Promise<void>;
}

const ENDED_BY_REQUEST = 'request_ended';

export function createOrderSyncRequestProgress(
  db: Kysely<DB>,
  clock: Clock,
): OrderSyncRequestProgress {
  const app = db.withSchema('app');
  return {
    async status(appId, id) {
      const row = await app
        .selectFrom('order_sync_requests')
        .select('status')
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row?.status ?? null;
    },
    async start(appId, id, seq) {
      const now = clock.now();
      await db.transaction().execute(async (trx) => {
        await trx
          .withSchema('app')
          .updateTable('order_sync_requests')
          .set({ status: 'running' })
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .where('status', '=', 'queued')
          .execute();
        await trx
          .withSchema('app')
          .updateTable('order_sync_request_windows')
          .set({ status: 'running', updated_at: now })
          .where('app_id', '=', appId)
          .where('sync_id', '=', id)
          .where('seq', '=', seq)
          .where('status', '=', 'queued')
          .execute();
      });
    },
    async finish(appId, id, seq, outcome) {
      const now = clock.now();
      await db.transaction().execute(async (trx) => {
        // The request row first: jobs of one request finishing at once are serialised here, so the
        // last of them sees every other row ended.
        const request = await trx
          .withSchema('app')
          .selectFrom('order_sync_requests')
          .select('status')
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (request === undefined) return;
        const windows = trx.withSchema('app');
        const ended = await windows
          .updateTable('order_sync_request_windows')
          .set(
            outcome.status === 'done'
              ? {
                  status: 'done',
                  fetched_count: outcome.fetched,
                  stored_count: outcome.stored,
                  error: null,
                  finished_at: now,
                  updated_at: now,
                }
              : { status: 'failed', error: outcome.error, finished_at: now, updated_at: now },
          )
          .where('app_id', '=', appId)
          .where('sync_id', '=', id)
          .where('seq', '=', seq)
          .where('status', 'in', LIVE)
          .executeTakeFirst();
        if (ended.numUpdatedRows === 0n) return;
        if (!(LIVE as readonly string[]).includes(request.status)) return;
        const tally = await windows
          .selectFrom('order_sync_request_windows')
          .select((eb) => [
            eb.fn.coalesce(eb.fn.sum<string>('fetched_count'), eb.lit(0)).as('fetched'),
            eb.fn.coalesce(eb.fn.sum<string>('stored_count'), eb.lit(0)).as('stored'),
            eb.fn.countAll<string>().filterWhere('status', 'in', LIVE).as('live'),
          ])
          .where('app_id', '=', appId)
          .where('sync_id', '=', id)
          .executeTakeFirstOrThrow();
        const counts = { fetched_count: Number(tally.fetched), stored_count: Number(tally.stored) };
        const status = manualSyncRequestAfterJob(outcome.status, Number(tally.live));
        const next =
          outcome.status === 'failed'
            ? { status, error: outcome.error, finished_at: now }
            : status === 'done'
              ? { status, error: null, finished_at: now }
              : { status };
        await trx
          .withSchema('app')
          .updateTable('order_sync_requests')
          .set({ ...counts, ...next })
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .where('status', 'in', LIVE)
          .execute();
        if (outcome.status === 'failed') {
          // The request has ended: its other rows will never be fetched (their jobs are dropped).
          await windows
            .updateTable('order_sync_request_windows')
            .set({ status: 'failed', error: ENDED_BY_REQUEST, finished_at: now, updated_at: now })
            .where('app_id', '=', appId)
            .where('sync_id', '=', id)
            .where('status', 'in', LIVE)
            .execute();
        }
      });
    },
  };
}
