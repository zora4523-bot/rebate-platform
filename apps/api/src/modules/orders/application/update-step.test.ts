// B1-08i 源码旁单元测试：更新步骤的写序、CAS 重读与整条拒收，以及告警事件与写库同一事务入队（不连库：
// 脚本化驱动只回预设结果，记录编译后的语句）。
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
const PENDING_ID = 77n;
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
          if (compiled.sql.startsWith('insert into "app"."order_sync_pending"')) {
            return Promise.resolve({ rows: [{ id: PENDING_ID }] as R[] });
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
        ['rights', 'PLATFORM_RIGHTS'],
        ['punish', 'PLATFORM_PUNISH'],
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
      onUpdated: vi.fn<OrderUpdateDeps['rebate']['onUpdated']>(() => {
        order.push('rebate');
        return Promise.resolve();
      }),
      onUnmappedStatus: vi.fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>(() => {
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

it('[AC-B1-08i#U9] P8 维权与处罚：change 相同，第三参数带各自的映射事件与原始码供 settlement 选 order_rights 类型', async () => {
  const calls: Parameters<OrderUpdateDeps['rebate']['onUpdated']>[] = [];
  for (const raw of ['rights', 'punish'] as const) {
    const { db } = scriptedDb(
      () => 1n,
      () => current,
    );
    const order: string[] = [];
    const d = deps(order);
    const step = createOrderUpdateStep(d);
    const outcome = await db
      .transaction()
      .execute((trx) => step.apply(trx, current, incoming({ raw_status: raw }), ctx));
    expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
    expect(order).toEqual(['rebate', 'event']);
    const onUpdated = vi.mocked(d.rebate.onUpdated);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    const call = onUpdated.mock.calls[0];
    if (call) calls.push(call);
  }
  const [rights, punish] = calls;
  expect(rights?.[1]).toMatchObject({ from_status: 'RECEIVED', to_status: 'RECEIVED', rule: 'P8' });
  expect(punish?.[1]).toEqual(rights?.[1]);
  expect(rights?.[2]).toEqual({ event: 'PLATFORM_RIGHTS', raw_status: 'rights' });
  expect(punish?.[2]).toEqual({ event: 'PLATFORM_PUNISH', raw_status: 'punish' });
});

it('[AC-B1-08i#U10] 表外码未入账：onUnmappedStatus 与 onUpdated 的第三参数同为事件空、原始码原样', async () => {
  const { db } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const d = deps(order);
  const step = createOrderUpdateStep(d);
  const outcome = await db
    .transaction()
    .execute((trx) => step.apply(trx, current, incoming({ raw_status: ' Unit-Unknown ' }), ctx));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  expect(order).toEqual(['unmapped', 'rebate', 'event']);
  const source = { event: null, raw_status: ' Unit-Unknown ' };
  expect(vi.mocked(d.rebate.onUnmappedStatus).mock.calls[0]?.[2]).toEqual(source);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[2]).toEqual(source);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[1]).toMatchObject({
    to_status: 'RECEIVED',
    rule: null,
  });
});

// —— 告警事件（D10-47 / D10-48；BR-ATTR-01 ⑦、BR-ATTR-07、BR-FUND-01 P10）——

type Publish = NonNullable<OrderUpdateDeps['alertEvents']>['publish'];
type Trx = Parameters<Publish>[0];

/** deps 再注入告警事件总线；每次入队在 order 里记 alert:<事件名>。 */
function withAlerts(order: string[], patch: Partial<OrderUpdateDeps> = {}) {
  const publish = vi.fn<Publish>((_trx, event) => {
    order.push(`alert:${event.name}`);
    return Promise.resolve({ eventId: event.eventId ?? 'unit', duplicate: false });
  });
  const d: OrderUpdateDeps = { ...deps(order), alertEvents: { publish }, ...patch };
  return { d, publish };
}

/** 在一个事务里跑一次 apply，同时交回该事务对象，供断言「同一 trx」。 */
async function run(
  db: ReturnType<typeof scriptedDb>['db'],
  d: OrderUpdateDeps,
  row: Row,
  order: UnionOrder,
  context: OrderPipelineContext = ctx,
) {
  let seen: Trx | undefined;
  const outcome = await db.transaction().execute((trx) => {
    seen = trx;
    return createOrderUpdateStep(d).apply(trx, row, order, context);
  });
  return { outcome, trx: seen };
}

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it.each([
  {
    label: 'P10 倒退',
    row: current,
    raw: 'paid',
    rule: 'P10',
    from: 'RECEIVED',
    event: 'PLATFORM_PAID',
  },
  {
    label: '表外事件',
    row: { ...current, platform_status: 'DEPOSIT_PAID', received_at: null } as Row,
    raw: 'rights',
    rule: 'illegal',
    from: 'DEPOSIT_PAID',
    event: 'PLATFORM_RIGHTS',
  },
])(
  '[AC-B1-08i#U11] $label 整条拒收：写待处理后同一 trx 入队 order.illegal_transition，载荷只有 id 与枚举，重复判出事件 ID 不变',
  async ({ row, raw, rule, from, event }) => {
    const { db, log } = scriptedDb(
      () => 1n,
      () => row,
    );
    const order: string[] = [];
    const { d, publish } = withAlerts(order);
    const first = await run(db, d, row, incoming({ raw_status: raw }));
    expect(first.outcome).toEqual({
      kind: 'pending',
      order_id: current.order_id,
      reason: 'ILLEGAL_TRANSITION',
    });
    expect(log.some((sql) => sql.startsWith('update'))).toBe(false);
    expect(order).toEqual(['alert:order.illegal_transition']);
    expect(publish).toHaveBeenCalledTimes(1);
    const [trx, published] = publish.mock.calls[0] ?? [];
    expect(trx).toBe(first.trx);
    expect(published).toEqual({
      appId: current.app_id,
      name: 'order.illegal_transition',
      payload: {
        order_id: current.order_id,
        pending_id: String(PENDING_ID),
        platform: 'pdd',
        reason: 'ILLEGAL_TRANSITION',
        rule,
        from_status: from,
        event,
        outcome: 'rejected',
      },
      eventId: expect.stringMatching(UUID_V8),
    });
    const text = JSON.stringify(published);
    for (const secret of [current.sub_order_id, current.user_id ?? '', raw]) {
      expect(text).not.toContain(`"${secret}"`);
    }
    // 同一条 open 待处理记录上再次判出同样的非法迁移：同一个事件 ID（总线按 ID 去重）。
    const again = await run(db, d, row, incoming({ raw_status: raw, raw_payload_id: '3' }));
    expect(again.outcome).toEqual(first.outcome);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[1].eventId).toBe(published?.eventId);
  },
);

it('[AC-B1-08i#U12] P10 开关关：照常写后与待处理同一 trx 入队 order.illegal_transition（status_kept），排在 order.updated 之后', async () => {
  const { db } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const { d, publish } = withAlerts(order, { regressionHold: () => false });
  const { outcome, trx } = await run(db, d, current, incoming({ raw_status: 'paid' }));
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  expect(order).toEqual(['rebate', 'event', 'alert:order.illegal_transition']);
  expect(publish.mock.calls[0]?.[0]).toBe(trx);
  expect(vi.mocked(d.rebate.onUpdated).mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[0]?.[1]).toMatchObject({
    name: 'order.illegal_transition',
    payload: {
      order_id: current.order_id,
      pending_id: String(PENDING_ID),
      rule: 'P10',
      from_status: 'RECEIVED',
      event: 'PLATFORM_PAID',
      outcome: 'status_kept',
    },
  });
});

it('[AC-B1-08i#U13] 已归属订单归因参数变化：参数列不写，同一 trx 入队 order.attr_param_changed，载荷只列变化的列名', async () => {
  const { db, log } = scriptedDb(
    () => 1n,
    () => current,
  );
  const order: string[] = [];
  const { d, publish } = withAlerts(order);
  const changed = incoming({
    raw_status: 'received',
    attr_params: {
      relation_id: 'unit-rel-new',
      sub_union_id: null,
      custom_parameters: 'unit-buyer',
    },
  });
  const { outcome, trx } = await run(db, d, current, changed);
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const update = log.find((sql) => sql.startsWith('update "app"."orders"')) ?? '';
  for (const column of ['"pid"', '"relation_id"', '"sub_union_id"', '"custom_params"']) {
    expect(update.split(' where ')[0]).not.toContain(column);
  }
  expect(order).toEqual(['rebate', 'event', 'alert:order.attr_param_changed']);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[0]?.[1]).toEqual({
    appId: current.app_id,
    name: 'order.attr_param_changed',
    payload: {
      order_id: current.order_id,
      platform: 'pdd',
      changed: ['relation_id', 'custom_params'],
    },
  });
  const text = JSON.stringify(publish.mock.calls[0]?.[1]);
  expect(text).not.toContain('unit-rel-new');
  expect(text).not.toContain('unit-buyer');
});

it('[AC-B1-08i#U14] 未归因订单重跑归属遇淘宝绑定冲突：不写 user_id，同一 trx 入队 order.attr_binding_conflict', async () => {
  const row = { ...current, platform: 'taobao', user_id: null } as Row;
  const { db, log } = scriptedDb(
    () => 1n,
    () => row,
  );
  const order: string[] = [];
  const bound = at('2026-10-01T00:00:00.000Z');
  const { d, publish } = withAlerts(order, {
    bindings: {
      findByRelation: vi.fn(() =>
        Promise.resolve([
          { user_id: 'unit-user-a', bound_at: bound, released_at: null, cooldown_until: null },
          { user_id: 'unit-user-b', bound_at: bound, released_at: null, cooldown_until: null },
        ]),
      ),
    },
  });
  const taobao = incoming({
    platform: 'taobao',
    raw_status: 'received',
    attr_params: { relation_id: 'unit-rel', sub_union_id: null, custom_parameters: null },
  });
  const { outcome, trx } = await run(db, d, row, taobao, { ...ctx, platform: 'taobao' });
  expect(outcome).toEqual({ kind: 'updated', order_id: current.order_id });
  const update = log.find((sql) => sql.startsWith('update "app"."orders"')) ?? '';
  expect(update.split(' where ')[0]).not.toContain('"user_id"');
  expect(order).toEqual(['rebate', 'event', 'alert:order.attr_binding_conflict']);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[0]).toBe(trx);
  expect(publish.mock.calls[0]?.[1]).toEqual({
    appId: current.app_id,
    name: 'order.attr_binding_conflict',
    payload: { order_id: current.order_id, platform: 'taobao' },
  });
  expect(JSON.stringify(publish.mock.calls[0]?.[1])).not.toContain('unit-user-');
});

it('[AC-B1-08i#U15] 映射表外的码（已入账整条拒收、未入账照常写）不入队 order.illegal_transition', async () => {
  for (const rebate of ['CREDITED', 'WAITING']) {
    const row = { ...current, rebate_status: rebate } as Row;
    const { db } = scriptedDb(
      () => 1n,
      () => row,
    );
    const order: string[] = [];
    const { d, publish } = withAlerts(order);
    const { outcome } = await run(db, d, row, incoming({ raw_status: 'unit-unknown' }));
    expect(outcome.kind).toBe(rebate === 'CREDITED' ? 'pending' : 'updated');
    expect(publish).not.toHaveBeenCalled();
  }
});
