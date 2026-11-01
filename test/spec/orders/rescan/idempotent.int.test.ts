// B1-04zm: the same window through the real pipeline, twice (D10-543). content_hash short-circuits
// the second pass: no write, no rebate call, no ledger entry, no status change.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import type {
  OrderRescanWindow,
  RescanStream,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { createRescanCursorStore } from '../../../../apps/api/src/modules/orders/infra/sync-cursors.ts';
import {
  handleOrderRescanWindow,
  type OrderRescanHandlerDeps,
} from '../../../../apps/api/src/modules/orders/jobs/order-rescan.ts';
import { fixture, pipeline, snapshot } from '../attribution/kit.ts';
import { job, logged } from './kit.ts';

const WINDOW_START = '2026-10-15T15:30:00.000Z';
const WINDOW_END = '2026-10-15T16:30:00.000Z';
const DONE = 'order_sync_rescan_window_done';
const MISSING = 'order_sync_rescan_found_missing';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function scenario() {
  const f = await fixture(db);
  const apply = vi
    .fn<NonNullable<OrderPipelineDeps['updateStep']>['apply']>()
    .mockResolvedValue({ kind: 'unchanged' });
  const orders = await pipeline({ ...f.deps, updateStep: { apply } });
  const stream: RescanStream = {
    app_id: f.ctx.app_id,
    platform: 'pdd',
    union_account_id: f.ctx.union_account_id,
    query_kind: 'rescan',
    scene: '-',
  };
  const win: OrderRescanWindow = {
    ...stream,
    window_start: WINDOW_START,
    window_end: WINDOW_END,
  };
  const listOrders = vi
    .fn<UnionAdapter['listOrders']>()
    .mockResolvedValue({ items: [f.incoming], nextCursor: null });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cursors = createRescanCursorStore(db, f.clock);
  const handler: OrderRescanHandlerDeps = {
    access: {
      listEnabledAccounts: async () => [],
      siteAuthAvailable: async () => true,
      offlineCircuitOpen: async () => false,
    },
    cursors,
    registry: { get: () => ({ listOrders }) },
    pipeline: orders,
    platforms: ['pdd'],
    logger: log,
  };
  return { ...f, apply, orders, stream, win, listOrders, log, cursors, handler };
}

async function ledgerEntries(appId: string) {
  return db.selectFrom('ledger_entries').select('id').where('app_id', '=', appId).execute();
}

it('[AC-B1-04zm#63] 同一窗口跑两遍：只首次入库一次，第二遍零写入、不产生分录、不改状态', async () => {
  const f = await scenario();
  await handleOrderRescanWindow(job(f.win, 1), f.handler);
  const first = await snapshot(db, f.ctx.app_id);
  expect(first.orders).toHaveLength(1);
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expect(logged(f.log.warn, MISSING)).toHaveLength(1);
  f.clock.advanceMs(86_400_000);
  await handleOrderRescanWindow(job(f.win, 2), f.handler);
  expect(await snapshot(db, f.ctx.app_id)).toEqual(first);
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expect(f.apply).not.toHaveBeenCalled();
  expect(await ledgerEntries(f.ctx.app_id)).toEqual([]);
  expect(logged(f.log.warn, MISSING)).toHaveLength(1);
  expect(logged(f.log.info, DONE).at(-1)).toMatchObject({ count: 1, inserted: 0 });
  expect(await f.cursors.read(f.stream)).toBe(WINDOW_END);
});

it('[AC-B1-04zm#64] 增量已入库的行回扫时短路：不算漏单、不告警', async () => {
  const f = await scenario();
  expect(await f.orders.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const before = await snapshot(db, f.ctx.app_id);
  await handleOrderRescanWindow(job(f.win), f.handler);
  expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expect(logged(f.log.warn, MISSING)).toEqual([]);
  expect(logged(f.log.info, DONE)).toEqual([
    expect.objectContaining({ pages: 1, count: 1, inserted: 0 }),
  ]);
});

it('[AC-B1-04zm#65] 内容变了的行走现有更新步骤，不算漏单', async () => {
  const f = await scenario();
  expect(await f.orders.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  f.listOrders.mockResolvedValue({
    items: [{ ...f.incoming, est_commission_fen: 790n }],
    nextCursor: null,
  });
  await handleOrderRescanWindow(job(f.win), f.handler);
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.onImported).toHaveBeenCalledTimes(1);
  expect(logged(f.log.warn, MISSING)).toEqual([]);
});

it('[AC-B1-04zm#66] 回扫推进只动 rescan 行，increment 游标一列不变', async () => {
  const f = await scenario();
  const increment: SyncStream = { ...f.stream, query_kind: 'increment' };
  await db
    .insertInto('sync_cursors')
    .values({ ...increment, cursor_at: WINDOW_START, updated_at: WINDOW_START })
    .execute();
  const rows = () =>
    db
      .selectFrom('sync_cursors')
      .selectAll()
      .where('app_id', '=', f.ctx.app_id)
      .where('query_kind', '=', 'increment')
      .execute();
  const before = await rows();
  await handleOrderRescanWindow(job(f.win), f.handler);
  expect(await rows()).toEqual(before);
  expect(await f.cursors.read(f.stream)).toBe(WINDOW_END);
});
