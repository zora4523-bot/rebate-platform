// Shared harness of the B2-04p rule tests (settle batch executor, job batch_execute).
// Orders, users and the real B2-04m credit come from the credit harness (test/spec/settlement/credit);
// batches and items are written here as the bill job / supplement command would have left them.
// The executor gets the real ledger snapshot read port, a switch map for the config reader, a
// recording wrapper around the real credit and a fake of the B2-04q port (not merged yet).
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createBatchCommandService } from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';
import {
  createBatchExecutor,
  type BatchExecuteResult,
  type BatchExecutor,
  type BatchExecutorDependencies,
  type BeneficiaryItemInput,
  type BeneficiaryItemResult,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import type {
  CreditOrderInput,
  CreditOrderResult,
  CreditRole,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { harness, type OrderSpec, type SeededOrder } from '../credit/kit.ts';

export const TIMEOUT = 180_000;
/** The credit harness clock starts here (same day as CONFIRMED_AT; the D-1 snapshot is timed out). */
export const NOW = '2032-07-24T10:00:00+08:00';
export const CONFIRMED_AT = '2032-07-24T09:00:00+08:00';
export const BILL = '2032-06';
export const PLATFORM = 'taobao';

interface TestDatabaseLike {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** One database per file; `db` seeds and reads, pool() opens an extra pool (closed afterwards). */
export function databaseFixture(create: () => Promise<TestDatabaseLike>) {
  let database: TestDatabaseLike | undefined;
  let url: string | undefined;
  let main: Kysely<DB> | undefined;
  const open: Kysely<DB>[] = [];
  beforeAll(async () => {
    database = await create();
    url = database.urlFor('couli_app');
    main = createDb({ connectionString: url, max: 8 });
    open.push(main);
  }, TIMEOUT);
  afterAll(async () => {
    try {
      await Promise.allSettled(open.map(destroyDb));
    } finally {
      await database?.drop();
    }
  }, TIMEOUT);
  return {
    get db(): Kysely<DB> {
      if (main === undefined) throw new Error('batch executor database is not open');
      return main;
    },
    /** A separate pool (its own connections); `name` becomes the backends' application_name. */
    pool(name?: string): Kysely<DB> {
      if (url === undefined) throw new Error('batch executor database is not open');
      const pool = createDb({
        connectionString: url,
        max: 4,
        ...(name === undefined ? {} : { applicationName: name }),
      });
      open.push(pool);
      return pool;
    },
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** E-18 P0: N 1000, no reserve → self 400, direct 80, PLATFORM:CREDIT 520 (BR-FUND-04 例). */
export function p0(subOrderId: string, extra: Partial<OrderSpec> = {}): OrderSpec {
  return {
    people: [
      { role: 'self', ratioBp: 4000 },
      { role: 'direct', ratioBp: 800 },
    ],
    reserveBp: 0,
    settleFen: 1000n,
    subOrderId,
    ...extra,
  };
}

export interface CreditCall {
  readonly by: string;
  readonly trx: Transaction<DB>;
  readonly input: CreditOrderInput;
}

export interface BeneficiaryCall {
  readonly by: string;
  readonly trx: Transaction<DB>;
  readonly input: BeneficiaryItemInput;
}

export interface SeededBatch {
  readonly batchId: string;
  /** settle_batch_items.id by order id (order items) or by beneficiary_credit_id (beneficiary items). */
  readonly items: Map<string, string>;
}

export async function fixture(db: Kysely<DB>) {
  const h = await harness(db);
  const { appId, clock } = h;
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `batch-executor-${adminId}`,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  await db
    .insertInto('settle_bills')
    .values({
      app_id: appId,
      bill_id: BILL,
      generation_started_at: new Date('2032-07-24T08:00:00+08:00'),
      generated_at: new Date('2032-07-24T08:00:00+08:00'),
      created_at: new Date('2032-07-24T08:00:00+08:00'),
    })
    .execute();

  // ---- config: both switches on unless a test changes them ---------------------------------------
  const switches = new Map<string, unknown>([
    ['settle.auto.enabled', true],
    [`credit.enabled.${PLATFORM}`, true],
  ]);
  const config = {
    get: vi.fn(async (_appId: string, key: string) => switches.get(key)),
  };

  // ---- the real B2-04m credit behind a recording wrapper -----------------------------------------
  const creditCalls: CreditCall[] = [];
  /** Runs inside the credit call of that order (on its transaction), before the real credit. */
  const creditHooks = new Map<string, (trx: Transaction<DB>) => Promise<void>>();
  async function credit(
    by: string,
    trx: Transaction<DB>,
    input: CreditOrderInput,
  ): Promise<CreditOrderResult> {
    creditCalls.push({ by, trx, input });
    const hook = creditHooks.get(input.orderId);
    if (hook !== undefined) {
      creditHooks.delete(input.orderId);
      await hook(trx);
    }
    return h.boot().credit(trx, input);
  }
  function onCredit(o: SeededOrder, hook: (trx: Transaction<DB>) => Promise<void>): void {
    creditHooks.set(o.orderId, hook);
  }

  // ---- fake of the B2-04q port: answers per beneficiary_credit_id -------------------------------
  const beneficiaryCalls: BeneficiaryCall[] = [];
  const beneficiaryAnswers = new Map<string, BeneficiaryItemResult>();

  // ---- events: the credit harness writer (event_log on the same transaction), with a switch to
  //      refuse settle.batch_done -----------------------------------------------------------------
  let doneRefusals = 0;
  const executorPublish = vi.fn<BatchExecutorDependencies['events']['publish']>(
    async (trx, event) => {
      if (event.name === 'settle.batch_done' && doneRefusals > 0) {
        doneRefusals -= 1;
        throw new Error('settle.batch_done refused by the test');
      }
      return h.publish(trx, event);
    },
  );

  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write() {
        // Lines are not asserted here.
      },
    },
  );

  /** One executor "process": its own dependencies on `via` (default: the shared pool). */
  function executor(via: Kysely<DB> = db, by = 'main'): BatchExecutor {
    return createBatchExecutor({
      db: via,
      clock,
      logger,
      config,
      snapshotStatus: getAssetSnapshotStatus,
      creditOrder: { credit: (trx, input) => credit(by, trx, input) },
      creditBeneficiary: {
        execute: async (trx, input) => {
          beneficiaryCalls.push({ by, trx, input });
          const answer = beneficiaryAnswers.get(input.beneficiaryCreditId);
          if (answer === undefined) throw new Error('no fake answer for this obligation');
          return answer;
        },
      },
      events: { publish: executorPublish },
    });
  }

  function run(batch: SeededBatch, via?: Kysely<DB>, by?: string): Promise<BatchExecuteResult> {
    return executor(via, by).run({ appId, batchId: batch.batchId });
  }

  // ---- seeding ------------------------------------------------------------------------------------
  async function batch(
    orders: readonly SeededOrder[],
    values: Partial<Insertable<DB['settle_batches']>> = {},
    seqs: ReadonlyMap<string, number> = new Map(),
  ): Promise<SeededBatch> {
    const batchId = randomUUID();
    const status = values.status ?? 'CONFIRMED';
    const confirmed = ['CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE'].includes(status);
    await db
      .insertInto('settle_batches')
      .values({
        batch_id: batchId,
        app_id: appId,
        bill_id: BILL,
        platform: PLATFORM,
        kind: 'main',
        status,
        settle_mode: 'IMMEDIATE',
        scheduled_at: null,
        confirmed_by: confirmed ? adminId : null,
        confirmed_at: confirmed ? new Date(CONFIRMED_AT) : null,
        cancelled_reason: status === 'CANCELLED' ? '测试驳回' : null,
        settle_run_id: null,
        order_count: orders.length,
        started_at: status === 'EXECUTING' || status === 'PARTIAL' ? new Date(CONFIRMED_AT) : null,
        finished_at: status === 'DONE' ? new Date(CONFIRMED_AT) : null,
        paused_by_switch_at: null,
        row_version: 3,
        created_at: new Date('2032-07-24T08:00:00+08:00'),
        ...values,
      })
      .execute();
    const items = new Map<string, string>();
    for (const o of orders) {
      const id = randomUUID();
      items.set(o.orderId, id);
      await db
        .insertInto('settle_batch_items')
        .values({
          id,
          app_id: appId,
          batch_id: batchId,
          item_type: 'order',
          order_id: o.orderId,
          user_id: null,
          role: null,
          beneficiary_credit_id: null,
          settle_seq: seqs.get(o.orderId) ?? o.seq,
          b_settle_fen: o.settleFen,
          amount_fen: null,
          result: null,
          skip_reason: null,
          created_at: new Date('2032-07-24T08:00:00+08:00'),
        })
        .execute();
    }
    return { batchId, items };
  }

  /** An open first_credit obligation of (o, role) and its beneficiary item in `b`. */
  async function beneficiaryItem(b: SeededBatch, o: SeededOrder, role: CreditRole) {
    const beneficiaryCreditId = randomUUID();
    await db
      .insertInto('beneficiary_credits')
      .values({
        beneficiary_credit_id: beneficiaryCreditId,
        app_id: appId,
        order_id: o.orderId,
        user_id: o.user(role),
        role,
        kind: 'first_credit',
        opened_by: 'R5',
        opened_ref: `earlier-batch-item-${o.orderId}`,
        origin_ledger_type: null,
        origin_sub_type: null,
        split_ref: 'commission_version:1',
        status: 'open',
        opened_at: new Date('2032-07-01T10:00:00+08:00'),
      })
      .execute();
    const id = randomUUID();
    b.items.set(beneficiaryCreditId, id);
    await db
      .insertInto('settle_batch_items')
      .values({
        id,
        app_id: appId,
        batch_id: b.batchId,
        item_type: 'beneficiary',
        order_id: o.orderId,
        user_id: o.user(role),
        role,
        beneficiary_credit_id: beneficiaryCreditId,
        settle_seq: o.seq,
        b_settle_fen: null,
        amount_fen: null,
        result: null,
        skip_reason: null,
        created_at: new Date('2032-07-24T08:00:00+08:00'),
      })
      .execute();
    return { beneficiaryCreditId, itemId: id };
  }

  /** The asset snapshot of accounting date `day` (YYYY-MM-DD) is complete (BR-FUND-18). */
  async function snapshotDone(day: string): Promise<void> {
    await db
      .insertInto('asset_snapshots')
      .values({
        id: randomUUID(),
        app_id: appId,
        snapshot_date: day,
        total_available_positive_fen: 0n,
        total_negative_fen: 0n,
        total_frozen_fen: 0n,
        total_waiting_fen: 0n,
        total_estimated_fen: 0n,
        waiting_comparable: true,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }

  // ---- reads --------------------------------------------------------------------------------------
  function stored(b: SeededBatch) {
    return db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .where('batch_id', '=', b.batchId)
      .executeTakeFirstOrThrow();
  }

  function item(b: SeededBatch, key: string) {
    const id = b.items.get(key);
    if (id === undefined) throw new Error('no such item in this batch');
    return db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  function itemOf(b: SeededBatch, o: SeededOrder) {
    return item(b, o.orderId);
  }

  async function rebateOf(o: SeededOrder): Promise<string> {
    return (await h.read(o)).rebate_status;
  }

  /** R5 rows of the order (each credit writes exactly one). */
  async function creditedHistory(o: SeededOrder): Promise<number> {
    return (await h.history(o)).filter((r) => r.field === 'rebate' && r.to_status === 'CREDITED')
      .length;
  }

  /** Every voucher key of this order. */
  async function orderVouchers(o: SeededOrder): Promise<string[]> {
    return (await h.voucherKeys()).filter((k) => k.startsWith(`${o.orderKey}:`));
  }

  async function doneEvents() {
    return (await h.published()).filter((e) => e.name === 'settle.batch_done');
  }

  /** Everything the executor may write for this app, for unchanged comparisons. */
  async function snapshot() {
    return {
      batches: await db
        .selectFrom('settle_batches')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('batch_id')
        .execute(),
      items: await db
        .selectFrom('settle_batch_items')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      ...(await h.state()),
    };
  }

  function creditedBy(by: string): string[] {
    return creditCalls.filter((c) => c.by === by).map((c) => c.input.orderId);
  }

  /** PARTIAL → EXECUTING through the real B2-04o command (SB8), both switches on. */
  async function resume(b: SeededBatch): Promise<void> {
    const row = await stored(b);
    const service = createBatchCommandService({
      db,
      clock,
      currentRound: async () => [],
      readiness: async () => ({
        autoEnabled: true,
        creditEnabled: true,
        snapshotCompleted: true,
        snapshotTimedOut: false,
      }),
    });
    await service.resumeBatch({
      appId,
      adminId,
      batchId: b.batchId,
      expectedRowVersion: row.row_version,
    });
    expect((await stored(b)).status).toBe('EXECUTING');
  }

  async function settleJobs(): Promise<number> {
    const rows = await db
      .selectFrom('settle_jobs')
      .select('id')
      .where('app_id', '=', appId)
      .execute();
    return rows.length;
  }

  return {
    h,
    db,
    appId,
    adminId,
    clock,
    switches,
    config,
    creditCalls,
    onCredit,
    beneficiaryCalls,
    beneficiaryAnswers,
    executorPublish,
    refuseDone(times = 1): void {
      doneRefusals = times;
    },
    executor,
    run,
    batch,
    beneficiaryItem,
    snapshotDone,
    stored,
    item,
    itemOf,
    rebateOf,
    creditedHistory,
    orderVouchers,
    doneEvents,
    snapshot,
    creditedBy,
    resume,
    settleJobs,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Seeds P0 orders `${tag}-<token>-01` … in ascending order_key (order_keys is keyed by platform and
 * sub_order_id across apps, so every call draws a fresh token).
 */
export async function p0Orders(
  f: Fixture,
  tag: string,
  count: number,
  extra: (index: number) => Partial<OrderSpec> = () => ({}),
): Promise<SeededOrder[]> {
  const token = randomUUID().slice(0, 8);
  const out: SeededOrder[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(await f.h.order(p0(`${tag}-${token}-${String(i).padStart(2, '0')}`, extra(i))));
  }
  return out;
}

/** The i-th seeded order (throws instead of an undefined under noUncheckedIndexedAccess). */
export function nth(orders: readonly SeededOrder[], index: number): SeededOrder {
  const o = orders[index];
  if (o === undefined) throw new Error(`no order #${String(index)}`);
  return o;
}

/** The voucher keys of one credited P0 order (self, direct, platform). */
export function p0Keys(o: SeededOrder): string[] {
  return [
    `${o.orderKey}:${o.user('self')}:self:CREDIT`,
    `${o.orderKey}:${o.user('direct')}:direct:CREDIT`,
    `${o.orderKey}:PLATFORM:CREDIT`,
  ].sort();
}

/** P0 credited exactly once: one R5 row, its three vouchers, 400 / 80 on the two balances. */
export async function creditedOnce(f: Fixture, o: SeededOrder): Promise<void> {
  expect(await f.rebateOf(o)).toBe('CREDITED');
  expect(await f.creditedHistory(o)).toBe(1);
  expect((await f.orderVouchers(o)).sort()).toEqual(p0Keys(o));
  expect(await f.h.balance(o.user('self'))).toBe(400n);
  expect(await f.h.balance(o.user('direct'))).toBe(80n);
}

/** P0 untouched: still WAITING, no voucher, no R5 row, zero balances. */
export async function untouched(f: Fixture, o: SeededOrder): Promise<void> {
  expect(await f.rebateOf(o)).toBe('WAITING');
  expect(await f.creditedHistory(o)).toBe(0);
  expect(await f.orderVouchers(o)).toEqual([]);
  expect(await f.h.balance(o.user('self'))).toBe(0n);
}

/** Polls until no backend with this application_name is left (a terminated one exits async). */
export async function waitGone(db: Kysely<DB>, name: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt += 1) {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${name}`.execute(db);
    if (result.rows[0]?.n === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backends named ${name} are still alive`);
}

/** Kills every backend of the named pool (the crash of an executor process). */
export async function terminate(db: Kysely<DB>, name: string): Promise<number> {
  const result = await sql<{ pid: number }>`
    SELECT pid FROM pg_stat_activity WHERE application_name = ${name}`.execute(db);
  for (const row of result.rows) {
    await sql`SELECT pg_terminate_backend(${row.pid})`.execute(db);
  }
  await waitGone(db, name);
  return result.rows.length;
}
