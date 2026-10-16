// B1-17a: BR-WATCH-05/19 and the brief's adjudicated storage shape.
// Synthetic prices only; writer policy, retention and platform payloads are out of scope.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  identity: string;
  default_expr: string | null;
}

export async function columns(db: Kysely<DB>): Promise<Column[]> {
  return (
    await sql<Column>`
      SELECT a.attname::text AS name, t.typname::text AS type,
        NOT a.attnotnull AS nullable, a.attidentity::text AS identity,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass('app.price_snapshot')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `.execute(db)
  ).rows;
}

// Called inside every test, before table SQL: main must fail assertions, not undefined_table.
export async function ready(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ name: string | null }>`
    SELECT to_regclass('app.price_snapshot')::text AS name
  `.execute(db);
  expect(result.rows[0]?.name, 'B1-17a creates app.price_snapshot').toBe('app.price_snapshot');
  expect((await columns(db)).map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      'id',
      'app_id',
      'platform',
      'product_key',
      'sku_key',
      'source_kind',
      'price_fen',
      'coupon_fen',
      'final_price_fen',
      'in_stock',
      'goods_sign_plan',
      'first_observed_at',
      'last_observed_at',
      'observation_count',
      'created_at',
    ]),
  );
}

export function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_id: 'couli',
    platform: 'taobao',
    product_key: 'tb:synthetic-price',
    sku_key: null,
    source_kind: 'detail',
    price_fen: 5000n,
    coupon_fen: 500n,
    final_price_fen: 4500n,
    in_stock: true,
    goods_sign_plan: null,
    first_observed_at: new Date('2032-06-15T08:00:00Z'),
    last_observed_at: new Date('2032-06-15T08:00:00Z'),
    observation_count: 1,
    ...overrides,
  };
}

export async function insert(db: Kysely<DB>, row: Record<string, unknown>): Promise<void> {
  await sql`INSERT INTO app.price_snapshot
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    OVERRIDING SYSTEM VALUE VALUES (${sql.join(Object.values(row))})`.execute(db);
}
