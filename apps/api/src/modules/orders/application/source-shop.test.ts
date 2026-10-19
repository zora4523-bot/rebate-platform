// B1-08p 源码旁单元测试：店铺维度在首次入库（INSERT）与同步更新（CAS UPDATE）里的接线
// （BR-ATTR-15 ③；编排补充口径 2～5）。不连库：脚本化驱动按语句回预设结果，只记录编译后的语句与参数。
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
import type { OrderPipelineContext, OrderPipelineDeps } from './pipeline-types.ts';
import type { OrderSourcePorts } from './source-backfill.ts';
import { createOrderUpdateStep, type OrderUpdateDeps } from './update-step.ts';

const NOW = '2026-10-17T17:30:00.000Z';
const ATTR = '2026-10-15T16:00:00.000Z';
const USER = '019a0000-0000-7000-8000-000000000042';
const SHOP = '73129';
const at = (iso: string) => new FixedClock(iso).now();

interface Compiled {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function scriptedDb(trace: string[], compiled: Compiled[]) {
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: Compiled): Promise<QueryResult<R>> {
          trace.push(query.sql);
          compiled.push({ sql: query.sql, parameters: query.parameters });
          if (query.sql.startsWith('update "app"."orders"')) {
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
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
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

/** 同店异品的点击：商品键对不上，只能经 ③ shop 命中。 */
const click: LinkLogCandidate = {
  id: 5n,
  link_id: '019a0000-0000-7000-8000-0000000000aa',
  user_id: USER,
  platform: 'pdd',
  product_key: 'pdd:other',
  shop_id: SHOP,
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
  return { sources: { linkLogs, productKey }, linkLogs, productKey };
}

function freshDeps(db: Kysely<DB>, sources: OrderSourcePorts, user: string | null) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: OrderPipelineDeps = {
    db,
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    pids: {
      find: () => Promise.resolve([{ pid_scene: 'share', status: 'active', site_id: null }]),
    },
    accounts: { syncStartAt: () => Promise.resolve(at('2026-10-01T00:00:00.000Z')) },
    users: { findByAttrCode: () => Promise.resolve(user) },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: { onImported: () => Promise.resolve() },
    sources,
    logger,
  };
  return { deps, logger };
}

function pendingLogs(logger: { info: ReturnType<typeof vi.fn> }) {
  return logger.info.mock.calls.filter(
    ([fields]) => (fields as { outcome?: string }).outcome === 'source_pending',
  );
}

it('[AC-B1-08p#U6] 首次入库：shop_id 随 INSERT（未归因也写），店铺交给回填走 ③ shop', async () => {
  for (const user of [USER, null]) {
    const trace: string[] = [];
    const compiled: Compiled[] = [];
    const p = ports(trace);
    const { deps } = freshDeps(scriptedDb(trace, compiled), p.sources, user);
    const result = await createOrderPipeline(deps).process(incoming({ shop_id: SHOP }), ctx);
    expect(result.kind).toBe('inserted');
    const insert = compiled.find((q) => q.sql.startsWith('insert into "app"."orders"'))!;
    expect(insert.sql).toContain('"shop_id"');
    expect(insert.parameters).toContain(SHOP);
    if (user === null) {
      expect(p.linkLogs).not.toHaveBeenCalled();
      expect(insert.sql).not.toContain('"source_match"');
    } else {
      expect(insert.parameters).toContain('shop');
      expect(insert.parameters).toContain(click.link_id);
    }
  }
});

it('[AC-B1-08p#U7] 首次入库：店铺显式为空且无命中 → 四列不进 INSERT 并记 source_pending；键缺失 → none', async () => {
  for (const shop of [null, undefined]) {
    const trace: string[] = [];
    const compiled: Compiled[] = [];
    const p = ports(trace, []);
    const { deps, logger } = freshDeps(scriptedDb(trace, compiled), p.sources, USER);
    const order = shop === null ? incoming({ shop_id: null }) : incoming();
    expect((await createOrderPipeline(deps).process(order, ctx)).kind).toBe('inserted');
    const insert = compiled.find((q) => q.sql.startsWith('insert into "app"."orders"'))!;
    expect(insert.sql).toContain('"shop_id"');
    if (shop === null) {
      expect(insert.sql).not.toContain('"source_match"');
      expect(pendingLogs(logger)).toEqual([
        [{ platform: 'pdd', app_id: 'unit-app', outcome: 'source_pending' }, expect.any(String)],
      ]);
    } else {
      expect(insert.sql).toContain('"source_match"');
      expect(insert.parameters).toContain('none');
      expect(pendingLogs(logger)).toEqual([]);
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
  rebate_status: 'PENDING',
  row_version: 3,
  commission_version: 1,
  user_id: USER,
  locked: false,
  pid: 'slot-ours',
  relation_id: null,
  sub_union_id: null,
  custom_params: '{"app":"n","uid":"abcd1234"}',
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

function updateDeps(sources: OrderSourcePorts | undefined) {
  const find = vi.fn<NonNullable<OrderUpdateDeps['pids']>['find']>(() =>
    Promise.resolve([{ pid_scene: 'share', status: 'active' as const, site_id: null }]),
  );
  const findByAttrCode = vi.fn(() => Promise.resolve(USER));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: OrderUpdateDeps = {
    clock: new FixedClock(NOW),
    statusMaps: () => map,
    users: { findByAttrCode },
    bindings: { findByRelation: () => Promise.resolve([]) },
    rebate: { onUpdated: () => Promise.resolve(), onUnmappedStatus: () => Promise.resolve() },
    events: { publish: () => Promise.resolve({ eventId: 'unit', duplicate: false }) },
    logger,
    pids: { find },
    ...(sources === undefined ? {} : { sources }),
  };
  return { deps, find, findByAttrCode, logger };
}

async function applyUpdate(
  deps: OrderUpdateDeps,
  row: Selectable<DB['orders']>,
  order: UnionOrder,
  trace: string[],
  compiled: Compiled[],
) {
  const step = createOrderUpdateStep(deps);
  const outcome = await scriptedDb(trace, compiled)
    .transaction()
    .execute((trx) => step.apply(trx, row, order, ctx));
  const updates = compiled.filter((q) => q.sql.startsWith('update "app"."orders"'));
  expect(updates).toHaveLength(1);
  const [set, where] = updates[0]!.sql.split(' where ');
  return { outcome, set: set!, where: where!, parameters: updates[0]!.parameters };
}

it('[AC-B1-08p#U8] 已归属待补单后到店铺：按库内推广位重跑一次，shop_id 与四列同一 CAS UPDATE，端口先于写', async () => {
  const trace: string[] = [];
  const compiled: Compiled[] = [];
  const p = ports(trace);
  const { deps, find, findByAttrCode } = updateDeps(p.sources);
  const { outcome, set, where, parameters } = await applyUpdate(
    deps,
    current,
    incoming({ shop_id: SHOP, promotion_slot: 'slot-other' }),
    trace,
    compiled,
  );
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  for (const column of ['shop_id', 'source_match', 'link_id', 'source_scene', 'agent_session_id']) {
    expect(set).toContain(`"${column}"`);
  }
  for (const column of ['user_id', 'buy_type', 'product_key', 'pid', 'rebate_status']) {
    expect(set).not.toContain(`"${column}"`);
  }
  expect(where).toContain('"source_match" is null');
  expect(where).not.toContain('"user_id" is null');
  expect(parameters).toContain(SHOP);
  expect(parameters).toContain('shop');
  expect(parameters).toContain(click.link_id);
  expect(find).toHaveBeenCalledExactlyOnceWith({
    appId: 'unit-app',
    platform: 'pdd',
    unionAccountId: 'unit-account',
    pid: 'slot-ours',
  });
  expect(findByAttrCode).not.toHaveBeenCalled();
  expect(p.linkLogs).toHaveBeenCalledExactlyOnceWith({
    appId: 'unit-app',
    userId: USER,
    platform: 'pdd',
    from: at('2026-09-30T16:00:00.000Z'),
    to: at(ATTR),
  });
  const write = trace.findIndex((sql) => sql.startsWith('update "app"."orders"'));
  expect(trace.indexOf('port:linkLogs')).toBeLessThan(write);
});

const noRetry: {
  readonly label: string;
  readonly row: Partial<Selectable<DB['orders']>>;
  readonly order: Partial<UnionOrder>;
}[] = [
  { label: '本次报文店铺仍为空', row: {}, order: { shop_id: null } },
  { label: '本次报文无店铺字段', row: {}, order: {} },
  { label: '已终结为 none', row: { source_match: 'none' }, order: { shop_id: SHOP } },
  { label: '库内已有店铺', row: { shop_id: 'stored-shop' }, order: { shop_id: SHOP } },
];

it.each(noRetry)('[AC-B1-08p#U9] $label：不重跑回填，四列不进 UPDATE', async ({ row, order }) => {
  const trace: string[] = [];
  const compiled: Compiled[] = [];
  const p = ports(trace);
  const { deps, find } = updateDeps(p.sources);
  const before = { ...current, ...row } as Selectable<DB['orders']>;
  const { set, where, parameters } = await applyUpdate(
    deps,
    before,
    incoming(order),
    trace,
    compiled,
  );
  expect(p.linkLogs).not.toHaveBeenCalled();
  expect(p.productKey).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
  expect(set).not.toContain('"source_match"');
  expect(where).not.toContain('"source_match"');
  // 只空 → 非空：库内为空且报文带来店铺才写（已终结的 none 也补店铺列，但不重跑）。
  const writesShop = before.shop_id === null && order.shop_id === SHOP;
  expect(set.includes('"shop_id"')).toBe(writesShop);
  expect(parameters.includes(SHOP)).toBe(writesShop);
});

it('[AC-B1-08p#U10] 未注入 sources：后到店铺只写 shop_id，不重跑', async () => {
  const trace: string[] = [];
  const compiled: Compiled[] = [];
  const { deps, find } = updateDeps(undefined);
  const { set } = await applyUpdate(deps, current, incoming({ shop_id: SHOP }), trace, compiled);
  expect(set).toContain('"shop_id"');
  expect(set).not.toContain('"source_match"');
  expect(find).not.toHaveBeenCalled();
});

it('[AC-B1-08p#U11] 未归因重跑成功：库内无店铺时用本次报文店铺；显式为空且无命中则待补', async () => {
  for (const shop of [SHOP, null]) {
    const trace: string[] = [];
    const compiled: Compiled[] = [];
    const p = ports(trace);
    const { deps, logger } = updateDeps(p.sources);
    const before = { ...current, user_id: null, rebate_status: 'UNATTRIBUTED' } as Selectable<
      DB['orders']
    >;
    const { set, where, parameters } = await applyUpdate(
      deps,
      before,
      incoming({ shop_id: shop }),
      trace,
      compiled,
    );
    expect(set).toContain('"user_id"');
    expect(where).toContain('"user_id" is null');
    expect(p.linkLogs).toHaveBeenCalledTimes(1);
    if (shop === SHOP) {
      expect(set).toContain('"shop_id"');
      expect(set).toContain('"source_match"');
      expect(where).toContain('"source_match" is null');
      expect(parameters).toContain('shop');
      expect(pendingLogs(logger)).toEqual([]);
    } else {
      expect(set).not.toContain('"shop_id"');
      expect(set).not.toContain('"source_match"');
      expect(where).not.toContain('"source_match"');
      expect(pendingLogs(logger)).toEqual([
        [{ platform: 'pdd', app_id: 'unit-app', outcome: 'source_pending' }, expect.any(String)],
      ]);
    }
  }
});
