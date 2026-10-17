import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { createOrderPipeline } from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineContext } from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import type { OrderPipelineDeps } from '../../../../apps/api/src/modules/orders/application/pipeline-types.ts';
import type {
  PlatformStatusEvent,
  StatusMap,
} from '../../../../apps/api/src/modules/orders/domain/status-map.ts';

export const NOW = '2026-10-17T17:30:00.000Z';
export const ATTR = '2026-10-15T16:00:00.000Z';
export const START = '2026-10-01T01:02:03.000Z';
export const RECEIVED = '2026-10-16T03:04:05.000Z';
export const SETTLED = '2026-10-17T04:05:06.000Z';
export const at = (iso: string) => new FixedClock(iso).now();

export function order(patch: Partial<UnionOrder> = {}): UnionOrder {
  // Synthetic normalized DTOs; these codes are test labels, not platform recordings.
  return {
    platform: 'pdd',
    order_id: 'synthetic-order',
    sub_order_id: 'synthetic-child',
    parent_order_id: 'synthetic-parent',
    promotion_slot: 'slot-ours',
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: '{"app":"n","uid":"abcd1234"}',
    },
    raw_status: 'paid',
    goods_id: 'synthetic-item',
    paid_fen: 12345n,
    commission_fen: 789n,
    est_commission_fen: 789n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    paid_at: at(ATTR),
    received_at: null,
    settled_at: null,
    modified_at: at('2026-10-16T08:09:10.000Z'),
    raw_payload_id: '101',
    ...patch,
  };
}

export function statusMap(platform: string): StatusMap {
  const events: [string, PlatformStatusEvent][] = [
    ['deposit', 'PLATFORM_DEPOSIT_PAID'],
    ['paid', 'PLATFORM_PAID'],
    ['received', 'PLATFORM_RECEIVED'],
    ['settled', 'PLATFORM_SETTLED'],
    ['invalid', 'PLATFORM_INVALID'],
    ['rights', 'PLATFORM_RIGHTS'],
    ['punish', 'PLATFORM_PUNISH'],
  ];
  return {
    platform,
    entries: new Map(
      events.map(([code, event]) => [
        code,
        { event, source: 'synthetic', verified: false, note: '' },
      ]),
    ),
  };
}

export async function capture<T>(action: () => T | Promise<T>) {
  try {
    return { ok: true as const, value: await action() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

// Factory errors become assertion failures; an existing NotImplemented must never make
// an expected-rejection case pass before process() has actually been reached.
export async function pipeline(deps: OrderPipelineDeps) {
  const result = await capture(() => createOrderPipeline(deps));
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw result.error;
  return result.value;
}

let fixtureSequence = 0;
export async function fixture(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
) {
  const offset = ++fixtureSequence * 1000;
  const fixtureTime = (iso: string) => {
    const source = new FixedClock(iso);
    source.advanceMs(offset);
    return source.now();
  };
  const clock = new FixedClock(NOW);
  const appId = `attr-${randomUUID()}`;
  const accountId = randomUUID();
  const userId = randomUUID();
  const incoming = order({ sub_order_id: randomUUID(), ...patch });
  const ctx: OrderPipelineContext = {
    app_id: appId,
    platform: patch.platform ?? 'pdd',
    union_account_id: accountId,
    query_kind: 'increment',
    scene: '-',
    window_start: START,
    window_end: NOW,
    requestId: randomUUID(),
  };
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: incoming.platform,
      account_name: 'synthetic',
      status: 'active',
      auth_status: 'active',
      sync_start_at: fixtureTime(START),
      created_at: fixtureTime('2026-09-01T02:03:04.000Z'),
      updated_at: fixtureTime('2026-09-02T03:04:05.000Z'),
    })
    .execute();
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: 'inv12345',
      attr_code: 'abcd1234',
      level: 'member',
      register_method: 'synthetic',
      created_at: fixtureTime('2026-09-03T04:05:06.000Z'),
      updated_at: fixtureTime('2026-09-04T05:06:07.000Z'),
    })
    .execute();
  const findPid = vi
    .fn<OrderPipelineDeps['pids']['find']>()
    .mockResolvedValue([{ pid_scene: 'share', status: 'active', site_id: null }]);
  const syncStartAt = vi
    .fn<OrderPipelineDeps['accounts']['syncStartAt']>()
    .mockResolvedValue(fixtureTime(START));
  const findUser = vi
    .fn<OrderPipelineDeps['users']['findByAttrCode']>()
    .mockImplementation(async ({ appId: app, attrCode }) => {
      const row = await db
        .selectFrom('users')
        .select('id')
        .where('app_id', '=', app)
        .where('attr_code', '=', attrCode)
        .executeTakeFirst();
      return row?.id ?? null;
    });
  const findBindings = vi
    .fn<OrderPipelineDeps['bindings']['findByRelation']>()
    .mockResolvedValue([]);
  const onImported = vi
    .fn<OrderPipelineDeps['rebate']['onImported']>()
    .mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: OrderPipelineDeps = {
    db,
    clock,
    statusMaps: statusMap,
    pids: { find: findPid },
    accounts: { syncStartAt },
    users: { findByAttrCode: findUser },
    bindings: { findByRelation: findBindings },
    rebate: { onImported },
    logger,
  };
  return {
    db,
    clock,
    ctx,
    incoming,
    userId,
    findPid,
    syncStartAt,
    findUser,
    findBindings,
    onImported,
    logger,
    deps,
  };
}

export async function snapshot(db: Kysely<DB>, appId: string) {
  return {
    keys: await db
      .selectFrom('order_keys')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('sub_order_id')
      .execute(),
    orders: await db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('sub_order_id')
      .execute(),
    history: await db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pending: await db
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    dropKeys: await db
      .selectFrom('order_sync_drop_keys')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    drops: await db
      .selectFrom('order_sync_drops')
      .selectAll()
      .select(sql<string>`date::text`.as('day'))
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    counters: await db
      .selectFrom('order_sync_counters')
      .selectAll()
      .select(sql<string>`date::text`.as('day'))
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

export function traceQueries(db: Kysely<DB>) {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const traced = db.withPlugin({
    transformQuery(args) {
      queries.push(new PostgresQueryCompiler().compileQuery(args.node, args.queryId));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: traced, queries };
}
