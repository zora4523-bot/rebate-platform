// B1-08j 源码旁单元测试：来源回填用例的端口编排，以及它在首次入库（INSERT）与未归因重跑（CAS UPDATE）
// 里的接线（BR-ATTR-15、BR-ATTR-01 ⑤）。不连库：脚本化驱动按语句回预设结果，只记录编译后的语句与参数。
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
import type { LinkLogCandidate } from '../domain/source-backfill.ts';
import type { PlatformStatusEvent, StatusMap } from '../domain/status-map.ts';
import { createOrderPipeline } from './pipeline-port.ts';
import type { OrderPipelineContext } from './pipeline-types.ts';
import { backfillOrderSource, type OrderSourcePorts } from './source-backfill.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const ATTR = '2026-10-15T16:00:00.000Z';
const USER = '019a0000-0000-7000-8000-000000000042';
const at = (iso: string) => new FixedClock(iso).now();

function scriptedDb(trace: string[]) {
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          trace.push(compiled.sql);
          if (compiled.sql.startsWith('update "app"."orders"')) {
            return Promise.resolve({ rows: [], numAffectedRows: 1n });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
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

function incoming(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTO; codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'unit-order',
    sub_order_id: 'unit-child',
    parent_order_id: null,
    promotion_slot: 'slot-ours',
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234","lk":"q1w2e3"}',
    },
    raw_status: 'received',
    goods_id: 'unit-item',
    paid_fen: 100n,
    commission_fen: 20n,
    est_commission_fen: 20n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at(ATTR),
    received_at: at('2026-10-16T03:04:05.000Z'),
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

const click: LinkLogCandidate = {
  id: 5n,
  link_id: '019a0000-0000-7000-8000-0000000000aa',
  user_id: USER,
  platform: 'pdd',
  product_key: 'pdd:1',
  shop_id: null,
  event: 'open',
  result_code: 0,
  pid_scene: 'share',
  scene: 'share',
  agent_session_id: null,
  created_at: at('2026-10-14T00:00:00.000Z'),
};

function ports(trace: string[], rows: readonly LinkLogCandidate[] = [click]) {
  const linkLogs = vi.fn<OrderSourcePorts['linkLogs']>(() => {
    trace.push('port:linkLogs');
    return Promise.resolve(rows);
  });
  const productKey = vi.fn<OrderSourcePorts['productKey']>(() => Promise.resolve('pdd:1'));
  const linkByCode = vi.fn<NonNullable<OrderSourcePorts['linkByCode']>>(() =>
    Promise.resolve(null),
  );
  return { sources: { linkLogs, productKey, linkByCode }, linkLogs, productKey, linkByCode };
}

it('[AC-B1-08j#U5] 用例：开关缺省不查 lk；窗口 [attr_at−360h, attr_at] 交端口；开关开且有 lk 才反查', async () => {
  const p = ports([]);
  const input = {
    appId: 'unit-app',
    platform: 'pdd' as const,
    userId: USER,
    attrAt: at(ATTR),
    pidScene: 'share',
    order: incoming(),
    shopId: null,
  };
  expect((await backfillOrderSource(p.sources, input)).source_match).toBe('product');
  expect(p.linkByCode).not.toHaveBeenCalled();
  expect(p.linkLogs).toHaveBeenCalledWith({
    appId: 'unit-app',
    userId: USER,
    platform: 'pdd',
    from: at('2026-09-30T16:00:00.000Z'),
    to: at(ATTR),
  });
  await backfillOrderSource({ ...p.sources, clickCode: () => true }, input);
  expect(p.linkByCode).toHaveBeenCalledExactlyOnceWith({
    appId: 'unit-app',
    platform: 'pdd',
    lk: 'q1w2e3',
  });
});

it('[AC-B1-08j#U6] 首次入库已归因：端口在任何写之前调用，四列只出现在 orders INSERT；未归因不调端口', async () => {
  for (const attributed of [true, false]) {
    const trace: string[] = [];
    const p = ports(trace);
    const pipeline = createOrderPipeline({
      db: scriptedDb(trace),
      clock: new FixedClock(NOW),
      statusMaps: () => map,
      pids: {
        find: () => Promise.resolve([{ pid_scene: 'share', status: 'active', site_id: null }]),
      },
      accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
      users: { findByAttrCode: () => Promise.resolve(attributed ? USER : null) },
      bindings: { findByRelation: () => Promise.resolve([]) },
      rebate: { onImported: () => Promise.resolve() },
      sources: p.sources,
    });
    const result = await pipeline.process(incoming({ raw_status: 'paid', received_at: null }), ctx);
    expect(result.kind).toBe('inserted');
    const insert = trace.find((sql) => sql.startsWith('insert into "app"."orders"'));
    expect(insert).toBeDefined();
    if (attributed) {
      expect(trace.indexOf('port:linkLogs')).toBeLessThan(
        trace.findIndex((sql) => sql.startsWith('insert')),
      );
      for (const column of ['source_match', 'link_id', 'source_scene', 'agent_session_id']) {
        expect(insert).toContain(`"${column}"`);
      }
    } else {
      expect(p.linkLogs).not.toHaveBeenCalled();
      expect(p.productKey).not.toHaveBeenCalled();
      expect(insert).not.toContain('"source_match"');
    }
  }
});

const current = {
  order_id: '019a0000-0000-7000-8000-000000000001',
  app_id: 'unit-app',
  platform: 'pdd',
  sub_order_id: 'unit-child',
  attr_at: at(ATTR),
  platform_status: 'RECEIVED',
  rebate_status: 'UNATTRIBUTED',
  row_version: 3,
  commission_version: 1,
  user_id: null,
  locked: false,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: null,
  shop_id: null,
  source_match: null,
  pay_amount_fen: 100n,
  est_commission_fen: 20n,
  settle_commission_fen: null,
  received_at: at('2026-10-16T03:04:05.000Z'),
  platform_received_at: null,
  deposit_paid_at: null,
  paid_at: at(ATTR),
  settled_at: null,
  platform_modified_at: null,
  parent_order_id: null,
  raw_item_id: 'unit-item',
  content_hash: 'old',
  raw_payload_id: 1n,
} as unknown as Selectable<DB['orders']>;

function updateDeps(sources: OrderSourcePorts, pids: OrderUpdateDeps['pids']): OrderUpdateDeps {
  return {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode: () => Promise.resolve(USER) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: { onUpdated: () => Promise.resolve(), onUnmappedStatus: () => Promise.resolve() },
    events: { publish: () => Promise.resolve({ eventId: 'unit', duplicate: false }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sources,
    ...(pids === undefined ? {} : { pids }),
  };
}

it('[AC-B1-08j#U7] 未归因重跑成功：四列并入同一 CAS UPDATE（WHERE source_match IS NULL）；推广位查无按 fallback 并在写后告警', async () => {
  const trace: string[] = [];
  const p = ports(trace, [{ ...click, pid_scene: 'agent' }]);
  const find = vi.fn<NonNullable<OrderUpdateDeps['pids']>['find']>(() => Promise.resolve([]));
  const deps = updateDeps(p.sources, { find });
  const step = createOrderUpdateStep(deps);
  const outcome = await scriptedDb(trace)
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming(), ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  expect(find).toHaveBeenCalledExactlyOnceWith({
    appId: 'unit-app',
    platform: 'pdd',
    unionAccountId: 'unit-account',
    pid: 'slot-ours',
  });
  const updates = trace.filter((sql) => sql.startsWith('update "app"."orders"'));
  expect(updates).toHaveLength(1);
  const [set, where] = updates[0]!.split(' where ');
  for (const column of ['source_match', 'link_id', 'source_scene', 'agent_session_id', 'user_id']) {
    expect(set).toContain(`"${column}"`);
  }
  expect(set).not.toMatch(/"(shop_id|product_key)"/);
  expect(where).toContain('"source_match" is null');
  expect(trace.indexOf('port:linkLogs')).toBeLessThan(trace.indexOf(updates[0]!));
  expect(deps.logger?.warn).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: 'unit-app', platform: 'pdd', reason: 'PID_SCENE_NOT_FOUND' }),
    expect.any(String),
  );
});

it.each([
  { label: '已有 source_match', row: { source_match: 'none' } },
  { label: '已有 user_id', row: { user_id: USER } },
  { label: 'locked', row: { locked: true } },
])('[AC-B1-08j#U8] $label：不调端口，UPDATE 不带来源四列', async ({ row }) => {
  const trace: string[] = [];
  const p = ports(trace);
  const find = vi.fn<NonNullable<OrderUpdateDeps['pids']>['find']>(() => Promise.resolve([]));
  const step = createOrderUpdateStep(updateDeps(p.sources, { find }));
  const before = { ...current, ...row } as Selectable<DB['orders']>;
  await scriptedDb(trace)
    .transaction()
    .execute((trx) => step.apply(trx, before, incoming(), ctx));
  expect(p.linkLogs).not.toHaveBeenCalled();
  expect(p.productKey).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
  const update = trace.find((sql) => sql.startsWith('update "app"."orders"'));
  expect(update?.split(' where ')[0]).not.toContain('"source_match"');
  expect(update?.split(' where ')[1]).not.toContain('"source_match"');
});
