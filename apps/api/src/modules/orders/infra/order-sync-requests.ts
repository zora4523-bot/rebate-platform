// B1-09i: app.order_sync_requests, the console's manual sync requests (04 §3.2; migration 0084).
// orders is the only writer: the admin entry inserts (one live row per (app_id, filter_digest) while
// queued or running, the partial unique index order_sync_requests_live_digest_key), the worker's
// order-sync handler updates only the columns 0084 grants (status, fetched_count, stored_count,
// error, finished_at). Every status change is a compare-and-set on the current status.
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type OrderSyncRequestRow = Selectable<DB['order_sync_requests']>;

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

/** The worker side: progress of one request. */
export interface OrderSyncRequestProgress {
  /** The request's status, or null when no row of (app_id, id) exists. */
  status(appId: string, id: string): Promise<string | null>;
  /** queued → running; a request already running or ended is left as it is. */
  start(appId: string, id: string): Promise<void>;
  /**
   * Adds one finished job's counts; with `final` a running request becomes done (finished_at at
   * the Clock). A request already ended keeps its status.
   */
  record(
    appId: string,
    id: string,
    counts: { readonly fetched: number; readonly stored: number },
    final: boolean,
  ): Promise<void>;
  /** queued / running → failed with the error and finished_at at the Clock. */
  fail(appId: string, id: string, error: string): Promise<void>;
}

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
    async start(appId, id) {
      await app
        .updateTable('order_sync_requests')
        .set({ status: 'running' })
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .where('status', '=', 'queued')
        .execute();
    },
    async record(appId, id, counts, final) {
      await db.transaction().execute(async (trx) => {
        await trx
          .withSchema('app')
          .updateTable('order_sync_requests')
          .set((eb) => ({
            fetched_count: eb('fetched_count', '+', counts.fetched),
            stored_count: eb('stored_count', '+', counts.stored),
          }))
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .execute();
        if (!final) return;
        await trx
          .withSchema('app')
          .updateTable('order_sync_requests')
          .set({ status: 'done', error: null, finished_at: clock.now() })
          .where('app_id', '=', appId)
          .where('id', '=', id)
          .where('status', 'in', LIVE)
          .execute();
      });
    },
    async fail(appId, id, error) {
      await app
        .updateTable('order_sync_requests')
        .set({ status: 'failed', error, finished_at: clock.now() })
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .where('status', 'in', LIVE)
        .execute();
    },
  };
}
