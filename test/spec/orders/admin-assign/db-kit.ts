// 连库的夹具，只被 *.int.test.ts 引用；不引 @couli/db/testing（testcontainers-only-in-int-tests），数据库
// 生命周期由各 *.int.test.ts 管理并传入。目标用户的风控状态与注销阶段用 risk / identity 的真实读取端口
// （createRiskStateBatchReader、createDeletionStageReader）读库；settlement 的返利端口是假的：只按 R3 / R3b
// 写 locked 与 rebate_status（claims-review 先例），记录调用与所用事务。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  sql,
  type Insertable,
  type Kysely,
  type Selectable,
  type Transaction,
  type Updateable,
} from 'kysely';
import { expect, vi } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { createDeletionStageReader } from '../../../../apps/api/src/modules/identity/ports/deletion-stage.ts';
import {
  assignOrder,
  type AdminAssignActor,
  type AdminAssignCommand,
  type AdminAssignDeletionReader,
  type AdminAssignDeps,
  type AdminAssignOutcome,
  type AdminAssignRebatePort,
  type AdminAssignRiskReader,
  type AdminAssignedInput,
} from '../../../../apps/api/src/modules/orders/application/admin-assign.ts';
import type { CommissionSnapshotPort } from '../../../../apps/api/src/modules/orders/application/commission-snapshot-step.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/application/risk-state-reader.ts';
import { EVT_CATALOG, EVT_PLAN } from '../../platform/events/kit.ts';
import { setupOn, teardown, type Database } from '../../platform/queue/int-kit.ts';
import { at, capture, fixture as baseFixture } from '../list-detail/kit.ts';
import { ADMIN_NAME, IP, REASON, UNATTRIBUTED } from './kit.ts';

export { at, capture };

export type Order = Selectable<DB['orders']>;
export type Trace = { sql: string; parameters: readonly unknown[]; settlement: boolean };

export async function open(database: Database) {
  const queue = setupOn(database, 'api', { catalog: EVT_CATALOG, plan: EVT_PLAN });
  const trace: Trace[] = [];
  const phase = { settlement: false };
  const raw = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  const db = raw.withPlugin({
    transformQuery(args) {
      const compiled = raw.getExecutor().compileQuery(args.node, args.queryId);
      trace.push({
        sql: compiled.sql,
        parameters: compiled.parameters,
        settlement: phase.settlement,
      });
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  try {
    await queue.runtime.start();
  } catch (error) {
    await destroyDb(raw);
    await teardown([queue]);
    throw error;
  }
  return {
    db,
    trace,
    phase,
    queue,
    async close() {
      await teardown([queue]);
      await destroyDb(raw);
    },
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export type RiskState = 'normal' | 'frozen' | 'appealing' | 'banned';
export type DeletionStage = 'cooling' | 'processing' | 'done';

export async function fixture(h: Harness) {
  const base = await baseFixture(h.db);
  const { db, clock, subject } = base;
  const appId = subject.app_id;

  async function admin(): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id,
        app_id: appId,
        login_name: `assign_${id}`,
        password_hash: 'synthetic-unused',
        is_super: false,
        status: 'active',
        display_name: ADMIN_NAME,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    return id;
  }
  const adminId = await admin();
  const actor: AdminAssignActor = { appId, adminId, ip: IP };
  /** Every transaction a port, reader, audit writer or the event bus was handed. */
  const transactions: Transaction<DB>[] = [];
  const hooks: {
    during?: (trx: Transaction<DB>, input: AdminAssignedInput) => Promise<void>;
  } = {};

  // Fake settlement (R3: UNATTRIBUTED → rebateTarget; R3b: VOID unchanged): writes locked and
  // rebate_status / settle_period only, after checking orders did not preempt those columns.
  const rebateTarget = { status: 'ESTIMATED', period: null as string | null };
  const rebate = {
    onAdminAssigned: vi.fn<AdminAssignRebatePort['onAdminAssigned']>(async (trx, input) => {
      transactions.push(trx);
      expect(trx.isTransaction).toBe(true);
      const current = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', input.before.app_id)
        .where('order_id', '=', input.before.order_id)
        .executeTakeFirstOrThrow();
      expect(current).toMatchObject({ locked: false, rebate_status: input.before.rebate_status });
      await hooks.during?.(trx, input);
      const patch: Updateable<DB['orders']> =
        input.before.rebate_status === 'VOID'
          ? { locked: true }
          : {
              locked: true,
              rebate_status: rebateTarget.status,
              settle_period: rebateTarget.period,
            };
      h.phase.settlement = true;
      try {
        await trx
          .updateTable('orders')
          .set(patch)
          .where('app_id', '=', input.before.app_id)
          .where('order_id', '=', input.before.order_id)
          .execute();
      } finally {
        h.phase.settlement = false;
      }
    }),
  };
  const snapshots = {
    create: vi.fn<CommissionSnapshotPort['create']>(async (trx) => {
      transactions.push(trx);
      return { kind: 'created' };
    }),
  };
  // Built here but checked only when publishing: until order.reassigned is in EVENT_NAMES the bus
  // refuses this routing table, which must fail the publishing tests by assertion, not the setup.
  const made = await capture(() =>
    createEventBus({
      queue: h.queue.runtime,
      clock,
      catalog: EVT_CATALOG,
      subscriptions: [{ consumer: 'alpha', events: ['order.reassigned'] }],
    }),
  );
  const events = {
    publish: vi.fn<AdminAssignDeps['events']['publish']>(async (trx, event) => {
      transactions.push(trx);
      expect(made.ok, 'order.reassigned registered in EVENT_NAMES (02 §11)').toBe(true);
      if (!made.ok) throw made.error;
      return made.value.publish(trx, event);
    }),
  };
  const auditOn = vi.fn<AdminAssignDeps['auditOn']>((trx) => {
    transactions.push(trx);
    return createAuditWriter({ db: trx, clock });
  });
  const riskReader = createRiskStateBatchReader({ db });
  const stageReader = createDeletionStageReader({ db });
  const targets = {
    risk: {
      read: vi.fn<AdminAssignRiskReader['read']>(async (executor, input) => {
        transactions.push(executor);
        return riskReader.read(executor, input);
      }),
    },
    deletion: {
      read: vi.fn<AdminAssignDeletionReader['read']>(async (executor, input) => {
        transactions.push(executor);
        return stageReader.read(executor, input);
      }),
    },
  };
  const details: AdminAssignDeps['details'] = {
    phones: async (_appId, userIds) =>
      new Map(userIds.map((id): [string, string | null] => [id, '138****0001'])),
    adminNames: async () => new Map<string, string>(),
    latestHold: async () => null,
    commissionSplit: async () => null,
    linkLogs: async () => [],
    creditEnabled: async () => true,
  };
  const deps: AdminAssignDeps = {
    db,
    clock,
    auditOn,
    events,
    rebate,
    targets,
    snapshots,
    details,
  };

  async function order(patch: Partial<Insertable<DB['orders']>> = {}): Promise<Order> {
    const row = await base.seed({
      ...UNATTRIBUTED,
      est_commission_fen: 1200n,
      settle_commission_fen: null,
      subsidy_commission_fen: 0n,
      source_match: null,
      source_scene: null,
      link_id: null,
      ...patch,
    });
    return db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', row.app_id)
      .where('order_id', '=', row.order_id)
      .executeTakeFirstOrThrow();
  }

  /** A user_risk_state row (BR-ID-31); frozen carries a future frozen_until. */
  async function risk(userId: string, state: RiskState, connection: Kysely<DB> = db) {
    await connection
      .insertInto('user_risk_state')
      .values({
        user_id: userId,
        app_id: appId,
        state,
        reason: null,
        reason_category: state === 'normal' ? null : 'other',
        frozen_until: state === 'frozen' ? at('2028-02-01T00:00:00.000Z') : null,
        changed_by: 'synthetic-admin',
        changed_at: clock.now(),
      })
      .execute();
  }

  /**
   * An account deletion of the user (BR-ID-27 / BR-ID-28): cooling is an open request still in its
   * window; processing an open request with users.status deleting; done a finished request with
   * users.status deleted.
   */
  async function deletion(userId: string, stage: DeletionStage, connection: Kysely<DB> = db) {
    const cooling = stage === 'cooling';
    await connection
      .insertInto('deletion_requests')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: userId,
        status: stage,
        apply_at: cooling ? at('2028-01-10T00:00:00.000Z') : at('2027-12-20T00:00:00.000Z'),
        cooling_until: cooling ? at('2028-01-25T00:00:00.000Z') : at('2028-01-04T00:00:00.000Z'),
        processed_at: stage === 'done' ? at('2028-01-05T00:00:00.000Z') : null,
        balance_snapshot_fen: 0n,
      })
      .execute();
    if (cooling) return;
    await connection
      .updateTable('users')
      .set({ status: stage === 'done' ? 'deleted' : 'deleting' })
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .execute();
  }

  /** An order and a user of another app (same database). */
  async function foreign() {
    const other = await baseFixture(db);
    const row = await other.seed({ ...UNATTRIBUTED });
    return { orderId: row.order_id, userId: other.subject.user_id };
  }

  async function claim(patch: Partial<Insertable<DB['claims']>> = {}) {
    return db
      .insertInto('claims')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: subject.user_id,
        platform: 'jd',
        order_no: `parent-${randomUUID()}`,
        order_no_type: 'parent',
        paid_date: '2027-12-12',
        status: 'manual_review',
        evidence_level: 'none',
        created_at: clock.now(),
        updated_at: clock.now(),
        reason: '原有审核说明',
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async function item(
    c: Awaited<ReturnType<typeof claim>>,
    o: Order,
    patch: Partial<Insertable<DB['claim_items']>> = {},
  ) {
    return db
      .insertInto('claim_items')
      .values({
        id: randomUUID(),
        app_id: c.app_id,
        claim_id: c.id,
        applicant_user_id: c.user_id,
        platform: o.platform,
        sub_order_id: o.sub_order_id,
        order_id: o.order_id,
        evidence: 'none',
        evidence_link_log_ids: [],
        created_at: clock.now(),
        updated_at: clock.now(),
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
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
    assignments: await connection
      .selectFrom('order_assignments')
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
    events: await connection
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    jobs: (
      await sql<{
        id: string;
        data: unknown;
        state: string;
      }>`select id, data, state::text from pgboss.job
      where name = 'evt.alpha' and data->'payload'->>'app_id' = ${appId} order by id`.execute(
        connection,
      )
    ).rows,
    claims: await connection
      .selectFrom('claims')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    items: await connection
      .selectFrom('claim_items')
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
  });

  type Options = { deps?: Partial<AdminAssignDeps>; actor?: Partial<AdminAssignActor> };
  function command(o: Order, patch: Partial<AdminAssignCommand> = {}): AdminAssignCommand {
    return {
      orderId: o.order_id,
      user_id: subject.user_id,
      expected_user_id: null,
      expected_locked: o.locked,
      reason: REASON,
      ...patch,
    };
  }
  async function assign(
    o: Order,
    patch: Partial<AdminAssignCommand> = {},
    options: Options = {},
  ): Promise<AdminAssignOutcome> {
    return assignOrder(
      { ...deps, ...options.deps },
      { ...actor, ...options.actor },
      command(o, patch),
    );
  }

  return {
    ...base,
    h,
    appId,
    adminId,
    actor,
    admin,
    deps,
    rebate,
    rebateTarget,
    snapshots,
    events,
    auditOn,
    targets,
    details,
    hooks,
    transactions,
    order,
    risk,
    deletion,
    foreign,
    claim,
    item,
    state,
    command,
    assign,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type State = Awaited<ReturnType<Fixture['state']>>;

export function assigned(result: AdminAssignOutcome) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('Expected a successful assignment');
  return result.data;
}

/** The order.reassigned rows of event_log (other events, e.g. claim.resolved, are not counted). */
export function reassignedEvents(s: State) {
  return s.events.filter((e) => e.name === 'order.reassigned');
}

/** Nothing of the order, its history, assignments, claims, events or jobs changed. */
export function untouched(after: State, before: State) {
  expect(after.orders).toEqual(before.orders);
  expect(after.history).toEqual(before.history);
  expect(after.assignments).toEqual(before.assignments);
  expect(after.items).toEqual(before.items);
  expect(after.claims).toEqual(before.claims);
  expect(after.events).toEqual(before.events);
  expect(after.jobs).toEqual(before.jobs);
  expect(after.pending).toEqual(before.pending);
}

/** Observe real PostgreSQL blocking behind `pid` (not a sleep that guesses who won). */
export async function blockedBy(db: Kysely<DB>, pid: number, finished: () => boolean) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    expect(finished(), 'the assignment must wait for the transaction holding the lock').toBe(false);
    const rows = await sql<{ query: string }>`select query from pg_stat_activity
      where ${pid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`.execute(db);
    if (rows.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect.fail('PostgreSQL did not observe the required lock wait');
}
