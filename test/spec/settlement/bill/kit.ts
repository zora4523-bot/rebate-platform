import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, PostgresQueryCompiler, type Kysely, type Insertable, type QueryId } from 'kysely';
import { afterAll, beforeAll, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createBillJob,
  type BillJobDependencies,
  type BillSourceOrder,
  type BillSourceRow,
  type BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  commission,
  fixture as snapshotFixture,
  appendVersion,
} from '../../commission/snapshot-read/fixtures.ts';

export const ledger = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as {
  getAssetSnapshotStatus: BillJobDependencies['snapshotStatus'];
  registerReconDiff: BillJobDependencies['registerDiff'];
};

export const NOW = '2032-07-24T00:10:00+08:00';
export const RUN = '2032-07-24T00:01:00+08:00';
export const BEFORE = '2032-07-23T23:59:00+08:00';
export const MONTH = '2032-06';
export const TIMEOUT = 60_000;

type TestDatabase = { urlFor(role: 'couli_app'): string; drop(): Promise<void> };
export function databaseFixture(createTestDatabase: () => Promise<TestDatabase>) {
  let database: TestDatabase;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  }, TIMEOUT);
  afterAll(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
  }, TIMEOUT);
  return {
    get db() {
      return db;
    },
  };
}

export function fixture(db: Kysely<DB>) {
  const appId = `bill-${randomUUID()}`;
  const clock = new FixedClock(NOW);
  const facts: { platform: string; orderKey: string; order: BillSourceOrder }[] = [];
  const orphans: BillSourceRow[] = [];
  const values = new Map<string, unknown>([
    ['credit.enabled.taobao', 'on'],
    ['credit.enabled.jd', 'on'],
  ]);
  const config = { get: vi.fn(async (_appId: string, key: string) => values.get(key)) };
  const readSource = vi.fn<BillJobDependencies['readSource']>(async (trx, input) => {
    const selected = facts.filter((f) => f.platform === input.platform);
    const rows: BillSourceRow[] = [];
    for (const f of selected) {
      const settlements = await trx
        .withSchema('app')
        .selectFrom('order_settlements')
        .selectAll()
        .where('app_id', '=', input.appId)
        .where('order_id', '=', f.order.orderId)
        .orderBy('seq', 'desc')
        .execute();
      rows.push({
        orderKey: f.orderKey,
        order: { ...f.order },
        settlements: settlements.map((s) => ({
          seq: s.seq,
          source: s.source as 'API' | 'STATEMENT',
          createdAt: s.created_at,
          settledAt: s.settled_at,
          commissionFen: s.settle_commission_fen,
        })),
      });
    }
    return [...rows, ...orphans];
  });
  const readSnapshot = vi.fn<BillJobDependencies['readSnapshot']>(
    commission.readCommissionSnapshot,
  );
  const readTljDeductFen = vi.fn<BillJobDependencies['readTljDeductFen']>(async () => 0n);
  const snapshotStatus = vi.fn<BillJobDependencies['snapshotStatus']>(
    ledger.getAssetSnapshotStatus,
  );
  const registerDiff = vi.fn<BillJobDependencies['registerDiff']>(ledger.registerReconDiff);
  // 测试专用事务见证：并非声明生产事件名；真实持久化由编排接线。
  const saveValidations = vi.fn<BillJobDependencies['saveValidations']>(
    async (trx, input, rows) => {
      for (const row of rows) {
        await trx
          .withSchema('app')
          .insertInto('event_log')
          .values({
            app_id: input.appId,
            event_id: randomUUID(),
            name: 'test.bill.validation',
            payload: JSON.stringify({ billId: input.billId, platform: input.platform, ...row }),
            occurred_at: clock.now(),
            created_at: clock.now(),
          })
          .execute();
      }
    },
  );
  const deps: BillJobDependencies = {
    clock,
    config,
    readSource,
    readSnapshot,
    readTljDeductFen,
    snapshotStatus,
    registerDiff,
    saveValidations,
  };
  // 在所有拒绝/回滚断言之前构造，避免 NotImplemented 被拒绝断言吞掉而误绿。
  const job = createBillJob(deps);
  return {
    appId,
    db,
    clock,
    facts,
    orphans,
    values,
    deps,
    job,
    readSource,
    readSnapshot,
    readTljDeductFen,
    snapshotStatus,
    registerDiff,
    saveValidations,
    run: (platform = 'taobao', runAt = new Date(RUN)) => job.run(db, { appId, platform, runAt }),
  };
}
export type Fixture = ReturnType<typeof fixture>;

export async function snapshot(h: Fixture, day = '2032-07-23', comparable = true) {
  await h.db
    .insertInto('asset_snapshots')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      snapshot_date: day,
      total_available_positive_fen: 0n,
      total_negative_fen: 0n,
      total_frozen_fen: 0n,
      total_waiting_fen: 0n,
      total_estimated_fen: 0n,
      waiting_comparable: comparable,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
}

export async function order(
  h: Fixture,
  patch: Partial<BillSourceOrder> = {},
  platform = 'taobao',
  pricing = { tlj: 0n, base: 850n, amounts: [425n, 85n, 42n], userTotal: 552n, retain: 298n },
) {
  const f = snapshotFixture();
  f.input = { appId: h.appId, orderId: randomUUID(), commissionVersion: 1 };
  // 固定非整除份额：850 的 50%、10%、5% 为 425、85、42，总额 552。
  await h.db
    .insertInto('order_keys')
    .values({
      app_id: h.appId,
      order_id: f.input.orderId,
      platform,
      sub_order_id: `synthetic-${f.input.orderId}`,
      attr_at: new Date(BEFORE),
    })
    .execute();
  await h.db
    .insertInto('commission_rule_versions')
    .values({
      app_id: h.appId,
      rule_version_id: f.ruleVersionId,
      status: 'published',
      effective_from: f.ruleEffectiveFrom,
      indirect_enabled: true,
      created_at: new Date(BEFORE),
    })
    .execute();
  await h.db
    .insertInto('commission_splits')
    .values({
      app_id: h.appId,
      order_id: f.input.orderId,
      rule_version_id: f.ruleVersionId,
      order_type: 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: new Date(BEFORE),
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 0n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: pricing.tlj,
      base_fen: pricing.base,
      platform_retain_fen: pricing.retain,
      beneficiaries: JSON.stringify(
        f.people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: p.level,
          initial_status: p.initialStatus,
          forfeit_reason: p.forfeitReason,
        })),
      ),
      created_at: new Date(BEFORE),
    })
    .execute();
  await appendVersion(
    h.db,
    f,
    1,
    pricing.base,
    1000n,
    pricing.amounts,
    pricing.userTotal,
    new Date(BEFORE),
  );
  const fact = {
    platform,
    orderKey: `${platform}:synthetic-${f.input.orderId}`,
    order: {
      orderId: f.input.orderId,
      rebateStatus: 'WAITING' as const,
      settlePeriod: MONTH,
      hold: false,
      rightsPending: false,
      commissionVersion: 1,
      unionAuthoritative: false,
      ...patch,
    },
  };
  h.facts.push(fact);
  return { ...f, fact, id: f.input.orderId, key: fact.orderKey };
}
export type Order = Awaited<ReturnType<typeof order>>;

export async function settlement(
  h: Fixture,
  o: Order,
  patch: Partial<Insertable<DB['order_settlements']>> = {},
) {
  await h.db
    .insertInto('order_settlements')
    .values({
      app_id: h.appId,
      order_id: o.id,
      seq: 1,
      source: 'API',
      settle_commission_fen: 1000n,
      settled_at: new Date(BEFORE),
      created_at: new Date(BEFORE),
      content_hash: randomUUID(),
      ...patch,
    })
    .execute();
}

export async function currentVersion(h: Fixture, o: Order) {
  await appendVersion(h.db, o, 2, 1700n, 2000n, [850n, 170n, 85n], 1105n, new Date(BEFORE));
  o.fact.order.commissionVersion = 2;
}

export async function obligation(
  h: Fixture,
  o: Order,
  patch: Partial<Insertable<DB['beneficiary_credits']>> = {},
) {
  const userId = patch.user_id ?? o.people[0]!.userId;
  await h.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: h.appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status: 'normal',
      register_method: 'phone',
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return h.db
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: randomUUID(),
      app_id: h.appId,
      order_id: o.id,
      user_id: userId,
      role: 'self',
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: 'synthetic-credit',
      split_ref: 'synthetic-attribution-v1',
      status: 'open',
      opened_at: new Date(BEFORE),
      created_at: new Date(BEFORE),
      ...patch,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function state(h: Fixture) {
  const scope = h.db.withSchema('app');
  return {
    bills: await scope
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('bill_id')
      .execute(),
    batches: await scope
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('batch_id')
      .execute(),
    items: await scope
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    jobs: await scope
      .selectFrom('settle_jobs')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    diffs: await scope
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    obligations: await scope
      .selectFrom('beneficiary_credits')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('beneficiary_credit_id')
      .execute(),
    validations: await scope
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', h.appId)
      .where('name', '=', 'test.bill.validation')
      .orderBy('event_id')
      .execute(),
    vouchers: await scope
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', h.appId)
      .execute(),
    balances: await scope
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', h.appId)
      .execute(),
  };
}

export async function validations(h: Fixture): Promise<BillValidation[]> {
  return (await state(h)).validations.map((r) => r.payload as unknown as BillValidation);
}

/** 数据库执行层故障：查询构造器与原生 SQL 都经同一执行器。 */
export function failItemWrite(db: Kysely<DB>) {
  const writes = new Set<QueryId>();
  return db.withPlugin({
    transformQuery(args) {
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (/insert\s+into\s+(?:"?app"?\.)?"?settle_batch_items"?/i.test(compiled.sql))
        writes.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      // 已执行 SQL 才抛错；Kysely 构造器和 sql 原生语句均覆盖，强制检验事务回滚。
      if (writes.delete(args.queryId)) throw new Error('injected item write failure');
      return args.result;
    },
  });
}

export async function jobConstraint(h: Fixture) {
  return (
    await sql<{ definition: string }>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'app.settle_jobs'::regclass AND conname = 'settle_jobs_run_key'
  `.execute(h.db)
  ).rows;
}
