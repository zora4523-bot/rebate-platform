import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import {
  approveClaimItem,
  rejectClaimItem,
  type ClaimReviewDeps,
  type ClaimReviewResult,
} from '../../../../apps/api/src/modules/orders/application/claim-review.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { fixture as baseFixture, at } from '../list-detail/kit.ts';
import { setupOn, teardown, type Database } from '../../platform/queue/int-kit.ts';
import { EVT_CATALOG, EVT_PLAN } from '../../platform/events/kit.ts';

export { at };
export const NOTE = '证据已经核实一致';
export const REVIEWER_CODES = [
  'NO_EVIDENCE',
  'EXPIRED_CLICK',
  'NOT_TRACKED',
  'OTHER_TLJ',
  'FRAUD',
  'OTHER',
];
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

export async function fixture(h: Harness) {
  const base = await baseFixture(h.db);
  const { db, subject, clock } = base;
  const appId = subject.app_id;
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `review_${adminId}`,
      password_hash: 'synthetic-unused',
      is_super: false,
      status: 'active',
      display_name: '测试客服',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const actor = { appId, adminId, ip: '192.0.2.20' };
  const transactions: Transaction<DB>[] = [];
  const rebateTarget = { status: 'ESTIMATED', period: null as string | null };
  const rebate = {
    onClaimApproved: vi.fn<ClaimReviewDeps['rebate']['onClaimApproved']>(async (trx, input) => {
      transactions.push(trx);
      expect(trx.isTransaction).toBe(true);
      const current = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', input.before.order_id)
        .executeTakeFirstOrThrow();
      // The fake settlement owns these two columns; orders must not preempt its CAS guard.
      expect(current).toMatchObject({ locked: false, rebate_status: 'UNATTRIBUTED' });
      expect(input.before).toMatchObject({
        user_id: null,
        locked: false,
        rebate_status: 'UNATTRIBUTED',
      });
      h.phase.settlement = true;
      try {
        await trx
          .updateTable('orders')
          .set({
            locked: true,
            rebate_status: rebateTarget.status,
            settle_period: rebateTarget.period,
          })
          .where('app_id', '=', appId)
          .where('order_id', '=', input.before.order_id)
          .execute();
      } finally {
        h.phase.settlement = false;
      }
    }),
  };
  const snapshots = {
    create: vi.fn<NonNullable<ClaimReviewDeps['snapshots']>['create']>(async (trx) => {
      transactions.push(trx);
      return { kind: 'created' };
    }),
  };
  const bus = createEventBus({
    queue: h.queue.runtime,
    clock,
    catalog: EVT_CATALOG,
    subscriptions: [{ consumer: 'alpha', events: ['claim.resolved'] }],
  });
  const events = {
    publish: vi.fn<ClaimReviewDeps['events']['publish']>(async (trx, event) => {
      transactions.push(trx);
      return bus.publish(trx, event);
    }),
  };
  const auditOn = vi.fn<ClaimReviewDeps['auditOn']>((trx) => {
    transactions.push(trx);
    return createAuditWriter({ db: trx, clock });
  });
  const deps: ClaimReviewDeps = {
    db,
    clock,
    rebate,
    snapshots,
    events,
    auditOn,
    details: {
      phones: async () => new Map([[subject.user_id, '138****0001']]),
      reviewerNames: async () => new Map([[adminId, '测试客服']]),
      linkMoments: async () => new Map(),
    },
  };
  async function order(patch: Partial<Insertable<DB['orders']>> = {}) {
    const row = await base.seed({
      user_id: null,
      user_basis: null,
      locked: false,
      rebate_status: 'UNATTRIBUTED',
      est_commission_fen: 1200n,
      settle_commission_fen: null,
      subsidy_commission_fen: 0n,
      ...patch,
    });
    return db
      .selectFrom('orders')
      .selectAll()
      .where('order_id', '=', row.order_id)
      .executeTakeFirstOrThrow();
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
    o: Awaited<ReturnType<typeof order>>,
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
  });
  async function review(
    mode: 'approve' | 'reject',
    i: Awaited<ReturnType<typeof item>>,
    patch: Partial<Parameters<typeof rejectClaimItem>[2]> = {},
    overrides: Partial<ClaimReviewDeps> = {},
  ) {
    const command = {
      claimId: i.claim_id,
      itemId: i.id,
      expected_row_version: i.row_version,
      reason: NOTE,
      reject_reason: 'NO_EVIDENCE',
      ...patch,
    };
    return mode === 'approve'
      ? approveClaimItem({ ...deps, ...overrides }, actor, command)
      : rejectClaimItem({ ...deps, ...overrides }, actor, command);
  }
  return {
    ...base,
    h,
    appId,
    actor,
    deps,
    order,
    claim,
    item,
    state,
    review,
    rebate,
    rebateTarget,
    snapshots,
    events,
    auditOn,
    transactions,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Item = Awaited<ReturnType<Fixture['item']>>;

export function success(result: ClaimReviewResult) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('Expected successful review');
  return result.data;
}
export async function decided(
  f: Fixture,
  i: Item,
  decision: string,
  rejectReason: string | null,
  admin: string | null,
) {
  const row = (await f.state()).items.find((r) => r.id === i.id);
  expect(row).toMatchObject({
    decision,
    reject_reason: rejectReason,
    decided_by: admin,
    decided_at: f.clock.now(),
    updated_at: f.clock.now(),
    row_version: i.row_version + 1,
  });
}
export function noAttribution(f: Fixture) {
  expect(f.rebate.onClaimApproved).not.toHaveBeenCalled();
  expect(f.snapshots.create).not.toHaveBeenCalled();
}
export async function resolved(
  f: Fixture,
  expected: { claim_id: string; user_id: string; status: string }[],
) {
  const s = await f.state();
  expect(s.events).toHaveLength(expected.length);
  expect(s.jobs).toHaveLength(expected.length);
  expect(s.events.map((e) => e.payload)).toEqual(
    expect.arrayContaining(
      expected.map((e) => ({
        v: 1,
        data: { ...e, app_id: f.appId },
      })),
    ),
  );
  for (const event of s.events) {
    expect(event).toMatchObject({
      app_id: f.appId,
      name: 'claim.resolved',
      occurred_at: f.clock.now(),
    });
    expect(s.jobs.find((j) => j.id === event.event_id)).toMatchObject({
      state: 'created',
      data: {
        name: 'claim.resolved',
        payload: {
          app_id: f.appId,
          v: 1,
          occurred_at: f.clock.now().toISOString(),
          data: (event.payload as { data: unknown }).data,
        },
      },
    });
  }
}
