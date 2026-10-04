// Shared helpers of the B1-08a order-table rule tests (a copy of test/spec/db/linking/kit.ts with
// order helpers added: rule-test files are add-only, so each task keeps its own copy). The new
// tables are not in db.gen.ts when these tests are written, so every statement is raw SQL.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
export const FOREIGN_KEY_VIOLATION = '23503';
export const PERMISSION_DENIED = '42501';
/** A value outside a CHECK list (23514) or outside a PostgreSQL enum type (22P02). */
export const REJECTED_VALUE = ['23514', '22P02'];

/** 04 §3.2 tables created by B1-08a. */
export const ORDER_TABLES = ['order_keys', 'orders', 'order_rights', 'order_settlements'] as const;

let app: Kysely<DB>;
let seq = 0;

export function useDb(db: Kysely<DB>): void {
  app = db;
}

/** Resolves to the SQLSTATE of the rejection, or 'no error' when the statement succeeds. */
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

export function unique(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq)}x${randomUUID().slice(0, 8)}`;
}

export type Column = { name: string; type: string; nullable: boolean; hasDefault: boolean };

const columnCache = new Map<string, Column[]>();

export async function columns(table: string): Promise<Column[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = await sql<{ name: string; type: string; nullable: string; has_default: boolean }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
           (column_default IS NOT NULL OR is_identity = 'YES' OR is_generated = 'ALWAYS')
             AS has_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY ordinal_position
  `.execute(app);
  const list = rows.rows.map((r) => ({
    name: r.name,
    type: r.type,
    nullable: r.nullable === 'YES',
    hasDefault: r.has_default,
  }));
  columnCache.set(table, list);
  return list;
}

export async function column(table: string, name: string): Promise<Column | undefined> {
  return (await columns(table)).find((c) => c.name === name);
}

/** Definitions of the CHECK constraints of the table that mention the column. */
export async function checkDefs(table: string, name: string): Promise<string[]> {
  const rows = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
  `.execute(app);
  return rows.rows.map((r) => r.def).filter((def) => new RegExp(`\\b${name}\\b`).test(def));
}

/** Every string literal listed by the CHECK constraints that mention the column. */
export async function checkedLiterals(table: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const def of await checkDefs(table, name)) {
    for (const m of def.matchAll(/'([^']*)'/g)) if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/** Labels of the PostgreSQL enum type of the column, if it has one. */
async function enumLabels(table: string, name: string): Promise<string[]> {
  const rows = await sql<{ label: string }>`
    SELECT e.enumlabel AS label
    FROM pg_attribute a
    JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_enum e ON e.enumtypid = a.atttypid
    WHERE n.nspname = 'app' AND t.relname = ${table} AND a.attname = ${name}
    ORDER BY e.enumsortorder
  `.execute(app);
  return rows.rows.map((r) => r.label);
}

export type ForeignKey = {
  name: string;
  columns: string[];
  target: string;
  targetColumns: string[];
  targetKind: string;
  onDelete: string;
  onUpdate: string;
};

/** Foreign keys declared on the table (on the parent for a partitioned table). */
export async function foreignKeys(table: string): Promise<ForeignKey[]> {
  const rows = await sql<{
    name: string;
    cols: string;
    target: string;
    target_cols: string;
    target_kind: string;
    on_delete: string;
    on_update: string;
  }>`
    SELECT c.conname AS name,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
           ft.relname AS target,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
             AS target_cols,
           ft.relkind::text AS target_kind,
           c.confdeltype::text AS on_delete,
           c.confupdtype::text AS on_update
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'f'
      AND c.conparentid = 0
  `.execute(app);
  return rows.rows.map((r) => ({
    name: r.name,
    columns: r.cols.split(','),
    target: r.target,
    targetColumns: r.target_cols.split(','),
    targetKind: r.target_kind,
    onDelete: r.on_delete,
    onUpdate: r.on_update,
  }));
}

/** Whether the role holds the privilege on app.<table>. */
export async function hasPrivilege(
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const rows = await sql<{ ok: boolean }>`
    SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS ok
  `.execute(app);
  return rows.rows[0]?.ok === true;
}

/**
 * Table and column referenced by a foreign key that contains the column (single-column keys, and
 * composite keys such as (app_id, user_id) → users (app_id, id): the column's own counterpart).
 */
async function referencedColumn(
  table: string,
  name: string,
): Promise<{ target: string; column: string } | null> {
  for (const fk of await foreignKeys(table)) {
    const at = fk.columns.indexOf(name);
    if (at >= 0 && name !== 'app_id') {
      const target = fk.targetColumns[at];
      if (target !== undefined) return { target: fk.target, column: target };
    }
  }
  return null;
}

async function filler(table: string, col: Column): Promise<unknown> {
  const ref = await referencedColumn(table, col.name);
  if (ref !== null) {
    // Any referenced table: insert a row there (recursively filled) and use its key.
    const row = await insertRow(ref.target, { app_id: 'couli' });
    return row[ref.column];
  }
  const literal =
    (await checkedLiterals(table, col.name))[0] ?? (await enumLabels(table, col.name))[0];
  if (literal !== undefined) return literal;
  switch (col.type) {
    case 'uuid':
      return randomUUID();
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return 0;
    case 'bool':
      return false;
    case 'timestamptz':
    case 'timestamp':
      return new Date('2026-10-01T00:00:00Z');
    case 'date':
      return '2026-10-01';
    case 'jsonb':
    case 'json':
      return '{}';
    case 'bytea':
      return Buffer.from(unique('b'));
    default:
      return unique('v');
  }
}

/** Inserts one row: the given values plus a value for every NOT NULL column without default. */
export async function insertRow(
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { ...values };
  for (const col of await columns(table)) {
    if (col.name in row || col.nullable || col.hasDefault) continue;
    row[col.name] = await filler(table, col);
  }
  const names = Object.keys(row);
  await sql`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))})
  `.execute(app);
  return row;
}

export const ATTR_AT = new Date('2026-10-04T08:00:00Z');

export type OrderKey = { orderId: unknown; platform: string; subOrderId: string; attrAt: Date };

/** Inserts an order_keys row (04 §3.2 order_keys) and returns its key columns. */
export async function newOrderKey(values: Record<string, unknown> = {}): Promise<OrderKey> {
  const row = await insertRow('order_keys', {
    app_id: 'couli',
    platform: 'taobao',
    sub_order_id: unique('sub'),
    attr_at: ATTR_AT,
    ...values,
  });
  return {
    orderId: row['order_id'],
    platform: String(row['platform']),
    subOrderId: String(row['sub_order_id']),
    attrAt: row['attr_at'] as Date,
  };
}

/**
 * Inserts an orders row for the key (a new key when none is given): order_id, platform,
 * sub_order_id and attr_at are the key's values (04 §3.2: attr_at equals order_keys.attr_at).
 */
export async function newOrder(
  values: Record<string, unknown> = {},
  key?: OrderKey,
): Promise<OrderKey> {
  const k = key ?? (await newOrderKey());
  await insertRow('orders', {
    app_id: 'couli',
    order_id: k.orderId,
    platform: k.platform,
    sub_order_id: k.subOrderId,
    attr_at: k.attrAt,
    raw_item_id: unique('item'),
    ...values,
  });
  return k;
}
