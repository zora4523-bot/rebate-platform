// B1-08i 源码旁单元测试：更新步骤的写序、CAS 重读与整条拒收（不连库：脚本化驱动只回预设结果，
// 记录编译后的语句）。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
  type Selectable,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionOrder } from '../../union/index.ts';
import type { PlatformStatusEvent, StatusMap } from '../domain/status-map.ts';
import type { OrderPipelineContext } from './pipeline-types.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const at = (iso: string) => new FixedClock(iso).now();

type Row = Selectable<DB['orders']>;

function scriptedDb(updatedRows: () => bigint, reread: () => Row | undefined) {
  const log: string[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          log.push(compiled.sql);
          if (compiled.sql.startsWith('update "app"."orders"')) {
            return Promise.resolve({ rows: [], numAffectedRows: updatedRows() });
          }
          if (compiled.sql.startsWith('select') && compiled.sql.includes('"app"."orders"')) {
            const row = reread();
            return Promise.resolve({ rows: (row === undefined ? [] : [row]) as R[] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log };
}

const map: StatusMap = {
  platform: 'pdd',
  entries: new Map(
    (
      [
        ['paid', 'PLATFORM_PAID'],
        ['received', 'PLATFORM_RECEIVED'],
      ] as [string, PlatformStatusEvent][]
    ).map(([code, event]) => [code, { event, source: 'unit', verified: false, note: '' }]),
  ),
};

const current = {
  order_id: '019a0000-0000-7000-8000-000000000001',
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  attr_at: at('2026-10-15T16:00:00.000Z'),
  platform_status: 'RECEIVED',
  rebate_status: 'WAITING',
  row_version: 3,
  commission_version: 1,
  user_id: '019a0000-0000-7000-8000-000000000042',
  locked: false,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: null,
  pay_amount_fen: 100n,
  est_commission_fen: 10n,
  settle_commission_fen: null,
  received_at: at('2026-10-16T03:04:05.000Z'),
  platform_received_at: null,
  deposit_paid_at: null,
  paid_at: at('2026-10-15T16:00:00.000Z'),
  settled_at: null,
  platform_modified_at: null,
  parent_order_id: null,
  raw_item_id: 'unit-item',
  content_hash: 'old',
  raw_payload_id: 1n,
} as Row;

function incoming(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: null },
    raw_status: 'received',
    goods_id: 'unit-item',
    paid_fen: 100n,
    commission_fen: 20n,
    est_commission_fen: 20n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at('2026-10-15T16:00:00.000Z'),
    received_at: null,
    settled_at: null,
    modified_at: null,
    raw_payload_id: '2',
    ...patch,
  };
}

const ctx: OrderPipelineContext = {
  app_id: 'unit-app',
  platform: 'pdd',
  union_account_id: 'unit-account',
  query_kind: 'increment',
  scene: '-',
  window_start: '2026-10-01T00:00:00.000Z',
  window_end: NOW,
  requestId: 'unit-request',
};

function deps(order: string[]): OrderUpdateDeps {
  return {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: vi.fn(() => Promise.resolve(null)) },
    bindings: { findByRelation: vi.fn(() => Promise.resolve([])) },
    rebate: {
      onUpdated: vi.fn(() => {
        order.push('rebate');
        return Promise.resolve();
      }),
      onUnmappedStatus: vi.fn(() => {
        order.push('unmapped');
        return Promise.resolve();
      }),
    },
    events: {
      publish: vi.fn(() => {
        order.push('event');
        return Promise.resolve({ eventId: 'unit', duplicate: false });
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

it('[AC-B1-08i#U6] 首次 CAS 0 行 → 重读一次后按新状态重新判定并写入', async () => {
  const results = [0n, 1n];
  const { db, log } = scriptedDb(
    () => results.shift() ?? 0n,
    () => ({ ...current, row_version: 4 }),
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: 'received' }), ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const updates = log.filter((sql) => sql.startsWith('update "app"."orders"'));
  expect(updates).toHaveLength(2);
  expect(log.filter((sql) => sql.startsWith('select'))).toHaveLength(1);
  expect(order).toEqual(['rebate', 'event']);
});

it('[AC-B1-08i#U7] 两次 CAS 都 0 行抛 ORDER_CAS_CONFLICT，不调用端口', async () => {
  const { db } = scriptedDb(
    () => 0n,
    () => current,
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  await expect(
    db.transaction().execute((trx) => step.apply(trx, current, incoming(), ctx)),
  ).rejects.toThrow('ORDER_CAS_CONFLICT');
  expect(order).toEqual([]);
});

it('[AC-B1-08i#U8] P10 倒退整条拒收：只写待处理（含说明），不 UPDATE、不调端口', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const step = createOrderUpdateStep(deps(order));
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: 'paid' }), ctx));
  expect(outcome).toEqual({
    kind: 'pending',
    order_id: current.order_id,
    reason: 'ILLEGAL_TRANSITION',
  });
  expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
  expect(
    log.filter((sql) => sql.startsWith('insert into "app"."order_sync_pending"')),
  ).toHaveLength(1);
  expect(order).toEqual([]);
});
