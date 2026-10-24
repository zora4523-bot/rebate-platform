import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { TestDatabase } from '@couli/db/testing';
import { sql, type Insertable, type Kysely, type Selectable, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { createOrderHoldAuditReader } from '../../../../apps/api/src/modules/admin/application/order-hold-audits.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import {
  holdOrder,
  unholdOrder,
  type AdminHoldActor,
  type AdminHoldCommand,
  type AdminHoldDeps,
  type AdminHoldOutcome,
} from '../../../../apps/api/src/modules/orders/application/admin-hold.ts';
import type {
  AdminHoldInput,
  AdminHoldResult,
  RebateAdminCommandPort,
} from '../../../../apps/api/src/modules/orders/application/rights-ports.ts';
import { orderLockKeyText } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import { NOW, at, capture, fixture as baseFixture } from '../list-detail/kit.ts';

export { NOW, at, capture };
export const NOTE = '用户反映订单异常，先暂停核实';
export const IP = '192.0.2.31';
export const ADMIN_NAME = '测试客服';
/** 20902 with data.resource=order: every refusal of R11, same state, open pending, stale version. */
export const CONFLICT = { code: 20902, data: { resource: 'order' } } as const;
export const fieldsError = (field: string) => ({ code: 20001, data: { fields: [field] } });
/** Holds order.claim and no risk.* point: the derived reason code is CS. */
export const CS_GRANTS: readonly string[] = ['order.view', 'order.hold', 'order.claim'];

export type Mode = 'hold' | 'unhold';
export type Order = Selectable<DB['orders']>;
export type Call = { mode: Mode; trx: Transaction<DB>; input: AdminHoldInput; current: Order };

export async function open(database: TestDatabase) {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  return {
    db,
    async close() {
      await destroyDb(db);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

/** Whether another connection could take the sub-order advisory lock and the order row now. */
export async function probe(db: Kysely<DB>, o: Order) {
  return db.transaction().execute(async (other) => {
    const key = orderLockKeyText(o.platform, o.sub_order_id);
    const advisory = await sql<{
      got: boolean;
    }>`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as got`.execute(other);
    const rows = await other
      .selectFrom('orders')
      .select('order_id')
      .where('app_id', '=', o.app_id)
      .where('order_id', '=', o.order_id)
      .forUpdate()
      .skipLocked()
      .execute();
    return { advisoryFree: advisory.rows[0]?.got === true, rowFree: rows.length === 1 };
  });
}

/** Polls until some session of this database waits for an advisory lock (or `flag` settles). */
export async function waitForLockWaiter(db: Kysely<DB>, flag: { settled: boolean }) {
  for (let i = 0; i < 150 && !flag.settled; i += 1) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`.execute(
      db,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export type Captured = { ok: true; value: AdminHoldOutcome } | { ok: false; error: unknown };

/**
 * Takes the sub-order lock on another connection, starts `request` while it is held, waits until
 * the request queues for that lock, applies `change` and commits; then the request's outcome.
 */
export async function underForeignLock(
  db: Kysely<DB>,
  o: Order,
  request: () => Promise<AdminHoldOutcome>,
  change: (other: Transaction<DB>) => Promise<void>,
): Promise<Captured> {
  let running: Promise<Captured> | undefined;
  await db.transaction().execute(async (other) => {
    const key = orderLockKeyText(o.platform, o.sub_order_id);
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(other);
    const flag = { settled: false };
    // Not awaited here: the request waits for this very lock until the commit below.
    running = Promise.resolve()
      .then(request)
      .then(
        (value): Captured => {
          flag.settled = true;
          return { ok: true, value };
        },
        (error: unknown): Captured => {
          flag.settled = true;
          return { ok: false, error };
        },
      );
    await waitForLockWaiter(db, flag);
    await change(other);
  });
  if (running === undefined) throw new Error('admin-hold kit: the request never started');
  return running;
}

export async function fixture(h: Harness) {
  const base = await baseFixture(h.db);
  const { db, clock, subject } = base;
  const appId = subject.app_id;
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `hold_${adminId}`,
      password_hash: 'synthetic-unused',
      is_super: false,
      status: 'active',
      display_name: ADMIN_NAME,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const actor: AdminHoldActor = { appId, adminId, isSuper: false, ip: IP };
  const grants = { keys: CS_GRANTS };
  const permissions = vi.fn<AdminHoldDeps['permissions']>(async () => grants.keys);
  const transactions: Transaction<DB>[] = [];
  const calls: Call[] = [];
  const hooks: { during?: (input: AdminHoldInput) => Promise<void> } = {};

  // Fake settlement with the R11 guard, the CAS on row_version and the same-state refusal; on
  // `applied` it writes hold, hold_reason and row_version only (no history: R11 books nothing).
  const settlement =
    (mode: Mode) =>
    async (trx: Transaction<DB>, input: AdminHoldInput): Promise<AdminHoldResult> => {
      transactions.push(trx);
      expect(trx.isTransaction).toBe(true);
      const current = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', input.before.app_id)
        .where('order_id', '=', input.before.order_id)
        .executeTakeFirstOrThrow();
      calls.push({ mode, trx, input, current });
      await hooks.during?.(input);
      if (!['ESTIMATED', 'WAITING'].includes(current.rebate_status)) {
        return { kind: 'not_applicable' };
      }
      if (current.row_version !== input.expected_row_version) return { kind: 'cas_conflict' };
      if (current.hold === (mode === 'hold')) return { kind: 'same_state' };
      await trx
        .updateTable('orders')
        .set({
          hold: mode === 'hold',
          hold_reason: mode === 'hold' ? input.reason_code : null,
          row_version: current.row_version + 1,
          updated_at: input.now,
        })
        .where('app_id', '=', current.app_id)
        .where('order_id', '=', current.order_id)
        .execute();
      return { kind: 'applied' };
    };
  const rebate = {
    adminHold: vi.fn<RebateAdminCommandPort['adminHold']>(settlement('hold')),
    adminUnhold: vi.fn<RebateAdminCommandPort['adminUnhold']>(settlement('unhold')),
  };
  const auditOn = vi.fn<AdminHoldDeps['auditOn']>((trx) => {
    transactions.push(trx);
    return createAuditWriter({ db: trx, clock });
  });
  const names: ReadonlyMap<string, string> = new Map([[adminId, ADMIN_NAME]]);
  const holds = createOrderHoldAuditReader(db);
  const deps: AdminHoldDeps = {
    db,
    clock,
    auditOn,
    permissions,
    ports: { rebate },
    details: {
      phones: async (_appId, userIds) =>
        new Map(userIds.map((id): [string, string | null] => [id, '138****0001'])),
      adminNames: async (_appId, adminIds) =>
        new Map([...names].filter(([id]) => adminIds.includes(id))),
      latestHold: (app, orderId) => holds.latestHold(app, orderId),
      commissionSplit: async () => null,
      linkLogs: async () => [],
      creditEnabled: async () => true,
    },
  };

  async function order(patch: Partial<Insertable<DB['orders']>> = {}): Promise<Order> {
    const row = await base.seed(patch);
    return db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', row.app_id)
      .where('order_id', '=', row.order_id)
      .executeTakeFirstOrThrow();
  }

  /** A BR-FUND-02 pending record of the order's sub-order (UNMAPPED_STATUS, open unless patched). */
  async function pending(
    o: Order,
    patch: Partial<Insertable<DB['order_sync_pending']>> = {},
    connection: Kysely<DB> = db,
  ) {
    await connection
      .insertInto('order_sync_pending')
      .values({
        app_id: o.app_id,
        platform: o.platform,
        sub_order_id: o.sub_order_id,
        order_id: o.order_id,
        reason: 'UNMAPPED_STATUS',
        raw_status: 'UNKNOWN_UNION_STATUS',
        detected_at: at('2028-01-14T00:00:00.000Z'),
        status: 'open',
        ...patch,
      })
      .execute();
  }

  const state = async (connection: Kysely<DB> = db) => ({
    orders: await connection
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .execute(),
    history: await connection
      .selectFrom('order_status_history')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pending: await connection
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audits: await connection
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  });

  type Options = { deps?: Partial<AdminHoldDeps>; actor?: Partial<AdminHoldActor> };
  function command(o: Order, patch: Partial<AdminHoldCommand>): AdminHoldCommand {
    return {
      orderId: o.order_id,
      note: NOTE,
      expected_row_version: o.row_version,
      ...patch,
    };
  }
  async function hold(
    o: Order,
    patch: Partial<AdminHoldCommand> = {},
    options: Options = {},
  ): Promise<AdminHoldOutcome> {
    return holdOrder(
      { ...deps, ...options.deps },
      { ...actor, ...options.actor },
      command(o, patch),
    );
  }
  async function unhold(
    o: Order,
    patch: Partial<AdminHoldCommand> = {},
    options: Options = {},
  ): Promise<AdminHoldOutcome> {
    return unholdOrder(
      { ...deps, ...options.deps },
      { ...actor, ...options.actor },
      command(o, { reason_code: 'CS', ...patch }),
    );
  }
  const run = (
    mode: Mode,
    o: Order,
    patch: Partial<AdminHoldCommand> = {},
    options: Options = {},
  ): Promise<AdminHoldOutcome> =>
    mode === 'hold' ? hold(o, patch, options) : unhold(o, patch, options);

  return {
    ...base,
    h,
    appId,
    adminId,
    actor,
    grants,
    permissions,
    rebate,
    auditOn,
    deps,
    calls,
    hooks,
    transactions,
    order,
    pending,
    state,
    hold,
    unhold,
    run,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The order a mode accepts: not held for hold, a manual CS hold for unhold. */
export function acceptable(mode: Mode): Partial<Insertable<DB['orders']>> {
  return mode === 'hold' ? { hold: false, hold_reason: null } : { hold: true, hold_reason: 'CS' };
}
