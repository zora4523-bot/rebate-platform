// Shared harness of the B2-04la rule tests (settlement's attribution ports R3 / R3b, BR-FUND-01).
// Only *.int.test.ts files import it; they own the database lifecycle and pass the connection in.
// Every expected value is written by hand from 08 BR-FUND-01 (rebate_status table R3 / R3b / R4)
// and from the orders ports (claim-review.ts ClaimApprovedInput, admin-assign.ts
// AdminAssignRebatePort); none is taken from an implementation.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  sql,
  type Insertable,
  type Kysely,
  type Selectable,
  type Transaction,
} from 'kysely';
import { expect, vi } from 'vitest';
import {
  lockOrderKey,
  orderLockKeyText,
  type SnapshotOutcome,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createAttributionRebatePort,
  type AttributionInput,
  type AttributionRebateDependencies,
  type AttributionRebatePort,
} from '../../../../apps/api/src/modules/settlement/index.ts';

/** input.now of every port call: the only clock the port may use. */
export const NOW = '2027-01-02T03:04:05.000Z';
/** Beijing 2027-01-01 00:00 → settle_period 2027-01 (BR-FUND-04 ②, crosses the year in UTC). */
export const RECEIVED = '2026-12-31T16:00:00.000Z';
export const PERIOD = '2027-01';
/** Seed timestamps, all before NOW so a write with input.now is visible. */
const SEEDED = '2026-12-20T08:00:00.000Z';
export const at = (iso: string) => new FixedClock(iso).now();

export type Order = Selectable<DB['orders']>;
export type OrderPatch = Partial<Insertable<DB['orders']>>;
export type PortMethod = 'onClaimApproved' | 'onAdminAssigned';
export const METHODS: readonly PortMethod[] = ['onClaimApproved', 'onAdminAssigned'];

export async function capture(action: () => unknown | Promise<unknown>) {
  try {
    await action();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error };
  }
}

export interface Query {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * One unattributed sub-order (user_id and user_basis empty, locked false, UNATTRIBUTED, PAID) plus
 * the real port. The factory runs here, before any assertion, so a NotImplemented skeleton can never
 * satisfy an expected rejection.
 */
export async function fixture(db: Kysely<DB>, patch: OrderPatch = {}) {
  const appId = `attr_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const orderId = randomUUID();
  const subOrderId = `s${randomUUID().replaceAll('-', '')}`;
  const platform = patch.platform ?? 'pdd';
  const attrAt = at('2026-12-15T04:00:00.000Z');
  const seeded = at(SEEDED);
  const userId = randomUUID();
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
      created_at: seeded,
      updated_at: seeded,
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
      created_at: seeded,
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
      user_id: null,
      user_basis: null,
      locked: false,
      buy_type: 'self',
      platform_status: 'PAID',
      rebate_status: 'UNATTRIBUTED',
      est_commission_fen: 1000n,
      commission_version: 1,
      quantity: 1,
      refunded_quantity: 0,
      created_at: seeded,
      updated_at: seeded,
      ...patch,
    })
    .execute();

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
  // settle.period_basis.<platform> unset = the default received_at (BR-FUND-04 ②).
  const configValues = new Map<string, unknown>();
  const get = vi.fn<AttributionRebateDependencies['config']['get']>(async (_app, key) =>
    configValues.get(key),
  );
  const deps: AttributionRebateDependencies = { logger, config: { get } };
  const port: AttributionRebatePort = createAttributionRebatePort(deps);

  const queries: Query[] = [];
  const traced = db.withPlugin({
    transformQuery(args) {
      queries.push(new PostgresQueryCompiler().compileQuery(args.node, args.queryId));
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });

  const snapshot: SnapshotOutcome = 'created';
  function input(before: Order, over: Partial<AttributionInput> = {}): AttributionInput {
    return { before, userId, now: at(NOW), snapshot, ...over };
  }

  /** Statements issued from inside the port call (see call / raw). */
  const portQueries: Query[] = [];
  const transactions: Transaction<DB>[] = [];

  const lockedRead = (trx: Transaction<DB>) =>
    trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirstOrThrow();

  /**
   * As orders does it: one transaction, the order_key advisory lock first, then SELECT … FOR UPDATE
   * of the row (the write-before snapshot), then the port. `between` runs after the snapshot and
   * before the port (to make the snapshot stale); `after` runs after the port, same transaction.
   * With `rescue` a port error is returned instead of thrown and the transaction COMMITS, so a
   * rejection that wrote anything before throwing is visible afterwards.
   */
  async function call(
    method: PortMethod,
    options: {
      over?: Partial<AttributionInput>;
      between?: (trx: Transaction<DB>) => Promise<void>;
      after?: (trx: Transaction<DB>) => Promise<void>;
      rescue?: boolean;
    } = {},
  ): Promise<{ before: Order; current: Order; error: unknown }> {
    return traced.transaction().execute(async (trx) => {
      transactions.push(trx);
      await lockOrderKey(trx, platform, subOrderId);
      const before = await lockedRead(trx);
      await options.between?.(trx);
      const current = await lockedRead(trx);
      const mark = queries.length;
      let error: unknown = undefined;
      try {
        await port[method](trx, input(before, options.over));
      } catch (caught) {
        if (options.rescue !== true) throw caught;
        error = caught;
      } finally {
        portQueries.push(...queries.slice(mark));
      }
      await options.after?.(trx);
      return { before, current, error };
    });
  }

  /** The port on a fresh transaction that holds no lock (lock-order tests). */
  async function raw(method: PortMethod, before: Order): Promise<void> {
    await traced.transaction().execute(async (trx) => {
      transactions.push(trx);
      const mark = queries.length;
      try {
        await port[method](trx, input(before));
      } finally {
        portQueries.push(...queries.slice(mark));
      }
    });
  }

  return {
    appId,
    orderId,
    subOrderId,
    platform,
    attrAt,
    userId,
    initial,
    read,
    history,
    logs,
    configValues,
    get,
    deps,
    port,
    queries,
    portQueries,
    transactions,
    input,
    call,
    raw,
    lockText: orderLockKeyText(platform, subOrderId),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

const WRITE = /^\s*(insert\s+into|update|delete\s+from)\s/i;

/** Statements of the port that change the orders row. */
export function orderWrites(f: Fixture): Query[] {
  return f.portQueries.filter((q) => /^\s*update\s+("app"\.)?"orders"/i.test(q.sql));
}

/**
 * BR-FUND-01 / 02 §18: every orders write of the port is a CAS on the old rebate_status and
 * row_version of this row (app_id, order_id), and bumps row_version.
 */
export function expectCas(f: Fixture) {
  const writes = orderWrites(f);
  expect(writes.length, 'the port writes the orders row').toBeGreaterThan(0);
  for (const q of writes) {
    const [set = '', where = ''] = q.sql.split(/\bwhere\b/i);
    for (const field of ['app_id', 'order_id', 'rebate_status', 'row_version']) {
      expect(where, q.sql).toContain(`"${field}"`);
    }
    expect(set, q.sql).toContain('"row_version"');
  }
}

/**
 * R3 / R3b have no entries (BR-FUND-01 记账「无分录」) and the port takes no users row or balance
 * lock: no statement of the port names the ledger or identity tables, no money rows exist.
 */
export async function expectNoMoney(db: Kysely<DB>, f: Fixture) {
  expect(
    f.portQueries.filter((q) =>
      /"(ledger_vouchers|ledger_entries|account_balances|accounts|users)"/.test(q.sql),
    ),
  ).toEqual([]);
  for (const table of ['ledger_vouchers', 'ledger_entries', 'account_balances'] as const) {
    expect(
      await db.selectFrom(table).selectAll().where('app_id', '=', f.appId).execute(),
      table,
    ).toEqual([]);
  }
  const row = await f.read();
  expect(row.booked_base_fen).toBeNull();
  expect(row.booked_n_fen).toBeNull();
}

/** Time only from input.now: no SQL clock in any statement of the port. */
export function expectNoSqlClock(f: Fixture) {
  for (const q of f.portQueries) {
    expect(q.sql, q.sql).not.toMatch(
      /\b(now\s*\(|current_timestamp|clock_timestamp|statement_timestamp|transaction_timestamp|localtimestamp|current_date)/i,
    );
  }
}

/** The port writes neither history nor any table other than orders. */
export function expectOnlyOrdersWritten(f: Fixture) {
  const others = f.portQueries.filter(
    (q) => WRITE.test(q.sql) && !/^\s*update\s+("app"\.)?"orders"/i.test(q.sql),
  );
  expect(others).toEqual([]);
}

/** Nothing of the row changed (decision before the write, BR-FUND-01 表外事件). */
export async function expectUntouched(f: Fixture, expected: Order) {
  expect(await f.read()).toEqual(expected);
}

/** BR-FUND-01 表外事件「记日志并告警」: a warn (or worse) line that carries an alert and the app. */
export function expectAlert(f: Fixture) {
  const alerted = f.logs.some((line) => {
    const level = line['level'];
    return (
      typeof level === 'number' &&
      level >= 40 &&
      typeof line['alert'] === 'string' &&
      line['app_id'] === f.appId
    );
  });
  expect(alerted, JSON.stringify(f.logs)).toBe(true);
}

/** The real port with a capturing logger and no config values (orders wiring tests). */
export function realPort() {
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const get = vi.fn<AttributionRebateDependencies['config']['get']>(async () => undefined);
  const port: AttributionRebatePort = createAttributionRebatePort({ logger, config: { get } });
  return { port, logs, get };
}

/** Observe real PostgreSQL blocking behind `pid` (not a sleep that guesses who won). */
export async function blockedBy(db: Kysely<DB>, pid: number, finished: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    expect(finished(), 'the port waits for the order_key lock').toBe(false);
    const rows = await sql<{ pid: number }>`select pid from pg_stat_activity
      where ${pid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`.execute(db);
    if (rows.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect.fail('PostgreSQL did not observe the required lock wait');
}
