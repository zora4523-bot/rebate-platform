import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Insertable, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { lockOrderKey } from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  ImportedOrder,
  OrderStatusSource,
  OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebateChangeInput,
  type RebatePort,
} from '../../../../apps/api/src/modules/settlement/index.ts';

export const NOW = '2027-01-02T03:04:05.000Z';
export const RECEIVED = '2026-12-31T16:00:00.000Z';
export const at = (iso: string) => new FixedClock(iso).now();
export type OrderPatch = Partial<Insertable<DB['orders']>>;

export async function capture(action: () => unknown | Promise<unknown>) {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error };
  }
}

export async function fixture(db: Kysely<DB>, patch: OrderPatch = {}) {
  const appId = `rebate-${randomUUID()}`;
  const orderId = randomUUID();
  const userId = randomUUID();
  const attrAt = at('2026-12-15T04:00:00Z');
  const subOrderId = randomUUID();
  const platform = patch.platform ?? 'pdd';
  const clock = new FixedClock(NOW);
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: 'abcd1234',
      attr_code: 'abcd1234',
      level: 'member',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: attrAt,
      created_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: attrAt,
      raw_item_id: 'synthetic',
      user_id: userId,
      user_basis: 'param',
      buy_type: 'self',
      platform_status: 'PAID',
      rebate_status: 'UNATTRIBUTED',
      est_commission_fen: 1000n,
      commission_version: 1,
      quantity: 4,
      refunded_quantity: 0,
      created_at: clock.now(),
      updated_at: clock.now(),
      ...patch,
    })
    .execute();
  const ref = { appId, orderId, attrAt };
  const read = () =>
    db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', orderId)
      .where('attr_at', '=', attrAt)
      .executeTakeFirstOrThrow();
  const history = () =>
    db
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', orderId)
      .orderBy('id')
      .execute();
  const events = () =>
    db.selectFrom('event_log').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const initial = await read();
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const configValues = new Map<string, unknown>();
  const get = vi.fn<RebateDependencies['config']['get']>(async (_app, key) =>
    configValues.get(key),
  );
  const bases = vi
    .fn<RebateDependencies['estimates']['bases']>()
    .mockResolvedValue({ before: 900n, after: 720n });
  // This is a commission port double, not a replacement implementation of settlement.
  // The returned bases are hand-written: valuation/formulas are outside this task's refs.
  const refresh = vi.fn<RebateDependencies['estimates']['refresh']>().mockResolvedValue(undefined);
  const publish = vi.fn<RebateDependencies['events']['publish']>(async (trx, event) => {
    const eventId = event.eventId ?? randomUUID();
    await trx
      .insertInto('event_log')
      .values({
        app_id: event.appId,
        event_id: eventId,
        name: event.name,
        payload: JSON.stringify(event.payload),
        occurred_at: clock.now(),
        created_at: clock.now(),
      })
      .execute();
    return { eventId, duplicate: false };
  });
  // Test-only transactional marker. Does not invent a UUID for system:risk in audit_logs.
  const audit = vi.fn<RebateDependencies['audit']['append']>(async (trx, input) => {
    await trx
      .insertInto('event_log')
      .values({
        app_id: input.appId,
        event_id: randomUUID(),
        name: 'test.hold_audit',
        payload: JSON.stringify(input),
        occurred_at: input.at,
        created_at: clock.now(),
      })
      .execute();
  });
  const deps: RebateDependencies = {
    clock,
    logger,
    config: { get },
    events: { publish },
    estimates: { bases, refresh },
    audit: { append: audit },
  };
  // Factory must succeed before any expected-rejection assertion, so NotImplemented cannot
  // accidentally satisfy a rollback/IllegalTransition test.
  const port = createRebatePort(deps);
  const transactions: Transaction<DB>[] = [];
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
  async function run<T>(action: (trx: Transaction<DB>, api: RebatePort) => Promise<T>) {
    return traced.transaction().execute(async (trx) => {
      await lockOrderKey(trx, platform, subOrderId);
      transactions.push(trx);
      return action(trx, port);
    });
  }
  const imported: ImportedOrder = {
    app_id: appId,
    order_id: orderId,
    attr_at: attrAt,
    attributed: initial.user_id !== null,
    platform_status: initial.platform_status as ImportedOrder['platform_status'],
    received_at: initial.received_at,
    snapshot: 'existing',
  };
  const change: OrderUpdateChange = {
    app_id: appId,
    order_id: orderId,
    attr_at: attrAt,
    from_status: initial.platform_status,
    to_status: initial.platform_status,
    rule: null,
    received_at: initial.received_at,
    est_before: initial.est_commission_fen,
    est_after: initial.est_commission_fen,
    settle_commission_fen: initial.settle_commission_fen,
    attributed_now: false,
    snapshot: 'existing',
  };
  const source: OrderStatusSource = { event: 'PLATFORM_PAID', raw_status: 'synthetic-paid' };
  async function update(
    delta: Partial<OrderUpdateChange> = {},
    origin: OrderStatusSource = source,
  ) {
    return run((trx, api) => api.onUpdated(trx, { ...change, ...delta }, origin));
  }
  const command: RebateChangeInput = {
    ...ref,
    estBefore: 1000n,
    estAfter: 800n,
    settleCommissionFen: null,
  };
  async function unmapped(rebateStatus = initial.rebate_status) {
    return run((trx, api) =>
      api.onUnmappedStatus(
        trx,
        {
          app_id: appId,
          order_id: orderId,
          attr_at: attrAt,
          rebate_status: rebateStatus,
        },
        { event: null, raw_status: 'synthetic-unmapped' },
      ),
    );
  }
  return {
    appId,
    orderId,
    userId,
    ref,
    attrAt,
    subOrderId,
    platform,
    clock,
    initial,
    read,
    history,
    events,
    logs,
    configValues,
    get,
    bases,
    refresh,
    publish,
    audit,
    deps,
    port,
    transactions,
    queries,
    run,
    imported,
    change,
    command,
    update,
    unmapped,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function noMoney(db: Kysely<DB>, f: Fixture) {
  expect(
    f.queries.filter(
      (q) =>
        /^(insert into|update|delete from) /i.test(q.sql) &&
        /"(ledger_vouchers|ledger_entries|account_balances)"/.test(q.sql),
    ),
  ).toEqual([]);
  for (const table of ['ledger_vouchers', 'ledger_entries', 'account_balances'] as const) {
    expect(
      await db.selectFrom(table).selectAll().where('app_id', '=', f.appId).execute(),
      table,
    ).toEqual([]);
  }
  expect((await f.read()).booked_base_fen).toBeNull();
}

export function expectCas(f: Fixture) {
  const writes = f.queries.filter((q) => /^update "app"\."orders"/i.test(q.sql));
  expect(writes.length).toBeGreaterThan(0);
  for (const q of writes) {
    const where = q.sql.split(/\bwhere\b/i)[1] ?? '';
    for (const field of ['app_id', 'order_id', 'rebate_status', 'row_version']) {
      expect(where, q.sql).toContain(`"${field}"`);
    }
  }
}
