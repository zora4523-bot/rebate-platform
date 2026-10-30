// B2-04zd 规则测试共用：合成数据库行，不调用被测实现生成期望。
// 数据库工厂由 *.int.test.ts 传入（只有它们导入 @couli/db/testing）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import type { BillSourceSelection } from '../../../../apps/api/src/modules/settlement/bill/index.ts';

export const NOW = '2032-07-24T00:10:00+08:00';
export const RUN = '2032-07-24T00:01:00+08:00';
export const BEFORE = '2032-07-23T23:59:00+08:00';
export const AFTER = '2032-07-24T00:20:00+08:00';
export const EARLY = '2032-05-20T10:00:00+08:00';
export const MONTH = '2032-06';
export const TIMEOUT = 60_000;

type TestDatabase = { urlFor(role: 'couli_app'): string; drop(): Promise<void> };

export function databaseFixture(createTestDatabase: () => Promise<TestDatabase>) {
  let database: TestDatabase;
  let db: Kysely<DB>;
  beforeAll(async () => {
    database = await createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
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

/** 只读事务：被测读口或「不落库」端口一旦写表，PG 直接拒绝（25006）。 */
export function readOnly<T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    return fn(trx);
  });
}

export function newApp(prefix = 'bill-ports'): string {
  return `${prefix}-${randomUUID()}`;
}

export function selection(appId: string, platform = 'taobao'): BillSourceSelection {
  return {
    appId,
    platform,
    runAt: new Date(RUN),
    billId: MONTH,
    generationStartedAt: new Date(NOW),
  };
}

export interface SeededOrder {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly key: string;
}

/** 只建 order_keys（孤儿结算行的归属）；返回本单键。 */
export async function seedKey(
  db: Kysely<DB>,
  appId: string,
  platform = 'taobao',
): Promise<SeededOrder> {
  const orderId = randomUUID();
  const subOrderId = `synthetic-${orderId}`;
  await db
    .withSchema('app')
    .insertInto('order_keys')
    .values({
      app_id: appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: new Date(EARLY),
    })
    .execute();
  return { appId, orderId, platform, subOrderId, key: `${platform}:${subOrderId}` };
}

export interface OrderPatch {
  readonly rebateStatus?: 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
  readonly settlePeriod?: string | null;
  readonly hold?: boolean;
  readonly rightsPending?: boolean;
  readonly commissionVersion?: number;
}

/** order_keys + orders 一行（attr_at 落默认分区）。 */
export async function seedOrder(
  db: Kysely<DB>,
  appId: string,
  patch: OrderPatch = {},
  platform = 'taobao',
): Promise<SeededOrder> {
  const seeded = await seedKey(db, appId, platform);
  const hold = patch.hold ?? false;
  await db
    .withSchema('app')
    .insertInto('orders')
    .values({
      app_id: appId,
      order_id: seeded.orderId,
      platform,
      sub_order_id: seeded.subOrderId,
      raw_item_id: 'synthetic-item',
      platform_status: 'RECEIVED',
      rebate_status: patch.rebateStatus ?? 'WAITING',
      hold,
      hold_reason: hold ? 'RISK' : null,
      rights_pending: patch.rightsPending ?? false,
      commission_version: patch.commissionVersion ?? 1,
      attr_at: new Date(EARLY),
      settle_period: patch.settlePeriod === undefined ? MONTH : patch.settlePeriod,
      created_at: new Date(EARLY),
      updated_at: new Date(EARLY),
    })
    .execute();
  return seeded;
}

export interface SettlementPatch {
  readonly seq?: number;
  readonly source?: 'API' | 'STATEMENT';
  readonly fen?: bigint;
  readonly createdAt?: string;
  readonly settledAt?: string;
}

export async function seedSettlement(
  db: Kysely<DB>,
  o: SeededOrder,
  patch: SettlementPatch = {},
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('order_settlements')
    .values({
      app_id: o.appId,
      order_id: o.orderId,
      seq: patch.seq ?? 1,
      source: patch.source ?? 'API',
      settle_commission_fen: patch.fen ?? 1000n,
      settled_at: new Date(patch.settledAt ?? BEFORE),
      created_at: new Date(patch.createdAt ?? BEFORE),
      content_hash: `synthetic-hash-${String(patch.seq ?? 1)}`,
    })
    .execute();
}

export interface DiffPatch {
  readonly type?: 'settle_amount_mismatch' | 'union_mismatch' | 'settle_missing';
  readonly status?: 'open' | 'processing' | 'adjusted' | 'written_off' | 'closed';
  readonly period?: string;
  readonly resolution?: Record<string, unknown> | null;
}

/** 直接种一张 R1 子订单差错单（ref_type=order、ref_id=order_key），状态与 resolution 按需。 */
export async function seedDiff(
  db: Kysely<DB>,
  appId: string,
  key: string,
  patch: DiffPatch = {},
): Promise<void> {
  const status = patch.status ?? 'open';
  const closed = status !== 'open' && status !== 'processing';
  await db
    .withSchema('app')
    .insertInto('recon_diffs')
    .values({
      id: randomUUID(),
      app_id: appId,
      type: patch.type ?? 'settle_amount_mismatch',
      source: 'R1',
      period: patch.period ?? MONTH,
      ref_type: 'order',
      ref_id: key,
      expected_fen: 850n,
      actual_fen: 1700n,
      diff_fen: 850n,
      status,
      handler_id: null,
      closed_at: closed ? new Date(BEFORE) : null,
      dedupe_key: null,
      resolution:
        patch.resolution === undefined || patch.resolution === null
          ? null
          : JSON.stringify(patch.resolution),
      created_at: new Date(EARLY),
      updated_at: new Date(BEFORE),
    })
    .execute();
}

const COUNTED = [
  'event_log',
  'settle_bills',
  'settle_batches',
  'settle_batch_items',
  'settle_jobs',
  'recon_diffs',
  'orders',
  'order_settlements',
  'commission_split_beneficiary_events',
] as const;

/** 本 app 各受检表的行数（只读断言的旁证）。 */
export async function tableCounts(db: Kysely<DB>, appId: string) {
  const counts: Record<string, number> = {};
  for (const table of COUNTED) {
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.table(`app.${table}`)} WHERE app_id = ${appId}
    `.execute(db);
    counts[table] = Number(rows[0]?.n ?? Number.NaN);
  }
  return counts;
}
