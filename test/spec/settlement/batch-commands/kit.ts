import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createBatchCommandService,
  type BatchCommandDeps,
  type ConfirmBillInput,
} from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';

export const NOW = '2032-07-24T10:00:00+08:00';
export const PAST = '2032-07-24T09:00:00+08:00';
export const FUTURE = '2032-07-24T11:00:00+08:00';
export const STATES = ['DRAFT', 'CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE', 'CANCELLED'] as const;
export const CONFLICT = { code: 20902, data: { resource: 'settle_batch' } };

export function databaseFixture() {
  let database: TestDatabase;
  let db: Kysely<DB>;
  beforeAll(async () => {
    // 标准入口由 globalSetup 读取 TEST_PG_ADMIN_URL；只在隔离容器运行。
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
  }, 60_000);
  afterAll(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
  }, 60_000);
  return {
    get db() {
      return db;
    },
  };
}

export async function fixture(db: Kysely<DB>) {
  const appId = `batch-command-${randomUUID()}`;
  const adminId = randomUUID();
  const clock = new FixedClock(NOW);
  const billId = '2032-06';
  const roundIds: string[] = [];
  const currentRound = vi.fn<BatchCommandDeps['currentRound']>(async () => [...roundIds]);
  const readiness = vi.fn<BatchCommandDeps['readiness']>(async () => ({
    autoEnabled: true,
    creditEnabled: true,
    snapshotCompleted: true,
    snapshotTimedOut: false,
  }));
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: adminId,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  await db
    .insertInto('settle_bills')
    .values({
      app_id: appId,
      bill_id: billId,
      generation_started_at: new Date(PAST),
      generated_at: new Date(PAST),
      created_at: new Date(PAST),
    })
    .execute();
  const deps: BatchCommandDeps = { db, clock, currentRound, readiness };
  return {
    db,
    appId,
    adminId,
    billId,
    clock,
    roundIds,
    currentRound,
    readiness,
    deps,
    service: () => createBatchCommandService(deps),
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function seedBatch(
  h: Fixture,
  values: Partial<Insertable<DB['settle_batches']>> = {},
  currentRound = true,
) {
  const status = values.status ?? 'DRAFT';
  const confirmed = ['CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE'].includes(status);
  const row = await h.db
    .insertInto('settle_batches')
    .values({
      batch_id: randomUUID(),
      app_id: h.appId,
      bill_id: h.billId,
      platform: 'taobao',
      kind: 'main',
      status,
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: confirmed ? h.adminId : null,
      confirmed_at: confirmed ? new Date(PAST) : null,
      cancelled_reason: status === 'CANCELLED' ? '旧轮已驳回' : null,
      settle_run_id: null,
      order_count: 1,
      started_at: null,
      finished_at: null,
      paused_by_switch_at: null,
      row_version: 4,
      created_at: new Date(PAST),
      ...values,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (currentRound) h.roundIds.push(row.batch_id);
  return row;
}
export type Batch = Awaited<ReturnType<typeof seedBatch>>;

export function command(h: Fixture, b: Batch) {
  return {
    appId: h.appId,
    adminId: h.adminId,
    batchId: b.batch_id,
    expectedRowVersion: b.row_version,
  };
}

export function confirm(
  h: Fixture,
  batches: readonly Batch[],
  extra: Partial<ConfirmBillInput> = {},
): ConfirmBillInput {
  return {
    appId: h.appId,
    adminId: h.adminId,
    billId: h.billId,
    expectedBatches: batches.map((b) => ({
      batchId: b.batch_id,
      expectedRowVersion: b.row_version,
    })),
    ...extra,
  };
}

export function stored(h: Fixture, b: Batch) {
  return h.db
    .selectFrom('settle_batches')
    .selectAll()
    .where('app_id', '=', h.appId)
    .where('batch_id', '=', b.batch_id)
    .executeTakeFirstOrThrow();
}

/** 非空 WAITING 订单和待处理明细，确保「不执行」断言不是空表断言。 */
export async function seedItem(h: Fixture, b: Batch) {
  const orderId = randomUUID();
  const subOrderId = randomUUID();
  await h.db
    .insertInto('order_keys')
    .values({
      app_id: h.appId,
      order_id: orderId,
      platform: b.platform,
      sub_order_id: subOrderId,
      attr_at: new Date(PAST),
    })
    .execute();
  await h.db
    .insertInto('orders')
    .values({
      app_id: h.appId,
      order_id: orderId,
      platform: b.platform,
      sub_order_id: subOrderId,
      raw_item_id: 'synthetic-item',
      platform_status: 'SETTLED',
      rebate_status: 'WAITING',
      attr_at: new Date(PAST),
      settle_period: h.billId,
      settle_commission_fen: 100n,
      created_at: new Date(PAST),
      updated_at: new Date(PAST),
    })
    .execute();
  await h.db
    .insertInto('order_settlements')
    .values({
      app_id: h.appId,
      order_id: orderId,
      seq: 1,
      source: 'API',
      settle_commission_fen: 100n,
      settled_at: new Date(PAST),
      content_hash: randomUUID(),
    })
    .execute();
  await h.db
    .insertInto('settle_batch_items')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      batch_id: b.batch_id,
      item_type: 'order',
      order_id: orderId,
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: 1,
      b_settle_fen: 100n,
      amount_fen: null,
      result: null,
      skip_reason: null,
      created_at: new Date(PAST),
    })
    .execute();
}

export async function untouched(h: Fixture) {
  return {
    bills: await h.db
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('bill_id')
      .execute(),
    orders: await h.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('order_id')
      .execute(),
    items: await h.db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('id')
      .execute(),
    vouchers: await h.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', h.appId)
      .execute(),
    balances: await h.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', h.appId)
      .execute(),
  };
}

export async function state(h: Fixture) {
  return {
    ...(await untouched(h)),
    batches: await h.db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', h.appId)
      .orderBy('batch_id')
      .execute(),
  };
}

export async function rejectedUnchanged(h: Fixture, run: () => Promise<unknown>, error: object) {
  const before = await state(h);
  // 回调包在 Promise 中，骨架的同步 NotImplemented 也由断言捕获，不算通过。
  await expect(Promise.resolve().then(run)).rejects.toMatchObject(error);
  expect(await state(h)).toEqual(before);
}
