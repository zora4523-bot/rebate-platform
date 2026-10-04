// Rule tests for the month partitions of orders (B1-08a; 规划/04 §3.2 orders: 按 attr_at 月分区,
// BR-ATTR-22, BR-ATTR-25, TECH-09; ADR-0001 §4.2 #4, #5; db/AGENTS.md rule 5: only the DEFAULT
// partition in the migration, month partitions through app.ensure_month_partition, whose
// allow-list and packages/db/src/partitions.ts must name orders). Own database per file, so the
// partition list starts from the migrations alone. Top-level it() only (规划/11 §4.3).
import {
  MONTH_PARTITIONED_TABLES,
  createDb,
  destroyDb,
  monthPartitionName,
  monthStartDate,
  type DB,
} from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { PERMISSION_DENIED, newOrder, newOrderKey, sqlState, useDb } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, maint].map((db) => destroyDb(db)));
  await database.drop();
});

const MARCH = new Date('2027-03-01T00:00:00Z');

async function ensurePartition(db: Kysely<DB>, month: Date): Promise<string> {
  const result = await sql<{ name: string }>`
    SELECT app.ensure_month_partition('orders', ${monthStartDate(month)}::date) AS name
  `.execute(db);
  return result.rows[0]?.name ?? '';
}

async function partitions(): Promise<{ name: string; bound: string }[]> {
  const rows = await sql<{ name: string; bound: string }>`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app' AND p.relname = 'orders'
    ORDER BY c.relname
  `.execute(app);
  return rows.rows;
}

async function partitionOf(orderId: unknown): Promise<string> {
  const rows = await sql<{ part: string }>`
    SELECT tableoid::regclass::text AS part FROM app.orders WHERE order_id = ${orderId}
  `.execute(app);
  return rows.rows[0]?.part ?? '';
}

it('[AC-B1-08a#36] the migrations create only the DEFAULT partition of orders (db/AGENTS.md #5)', async () => {
  const list = await partitions();
  expect(list.map((p) => p.bound)).toEqual(['DEFAULT']);
});

it('[AC-B1-08a#37] orders is on the month-partition allow-list in SQL and in packages/db (db/AGENTS.md #5)', async () => {
  expect([...MONTH_PARTITIONED_TABLES] as string[]).toContain('orders');
  expect(await ensurePartition(maint, MARCH)).toBe(monthPartitionName('orders', MARCH));
  expect(await ensurePartition(maint, new Date('2027-03-31T23:59:59.999Z'))).toBe('orders_p202703');
  const march = (await partitions()).find((p) => p.name === 'orders_p202703');
  expect(march?.bound).toBe(
    "FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00')",
  );
});

it('[AC-B1-08a#38] an order lands in the partition of its attr_at month, others in DEFAULT (BR-ATTR-22)', async () => {
  const inMarch = await newOrder(
    {},
    await newOrderKey({ attr_at: new Date('2027-03-15T08:00:00+08:00') }),
  );
  expect(await partitionOf(inMarch.orderId)).toBe('app.orders_p202703');
  const unpartitioned = await newOrder(
    {},
    await newOrderKey({ attr_at: new Date('2031-01-01T00:00:00Z') }),
  );
  expect(await partitionOf(unpartitioned.orderId)).toBe('app.orders_default');
});

it('[AC-B1-08a#39] couli_app cannot create order partitions itself', async () => {
  expect(await sqlState(ensurePartition(app, new Date('2027-05-01T00:00:00Z')))).toBe(
    PERMISSION_DENIED,
  );
  expect(
    await sqlState(
      sql`CREATE TABLE app.orders_p209901 PARTITION OF app.orders
          FOR VALUES FROM ('2099-01-01 00:00:00+00') TO ('2099-02-01 00:00:00+00')`.execute(app),
    ),
  ).toBe(PERMISSION_DENIED);
});
