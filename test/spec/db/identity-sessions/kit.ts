// B1-02b's local copy of the B1-02a identity helpers: existing rule assets are add-only.
// Raw SQL deliberately works before the new tables enter generated DB types.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';

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

export function hex64(): string {
  return (randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')).slice(0, 64);
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

/** First string literal listed by a CHECK constraint that mentions the column, if any. */
export async function checkedLiteral(table: string, column: string): Promise<string | null> {
  const rows = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
  `.execute(app);
  for (const { def } of rows.rows) {
    if (!new RegExp(`\\b${column}\\b`).test(def)) continue;
    const literal = /'([^']*)'::/.exec(def) ?? /'([^']*)'/.exec(def);
    if (literal?.[1] !== undefined) return literal[1];
  }
  return null;
}

/** Table referenced by a single-column foreign key on the column, if any. */
async function referencedTable(table: string, column: string): Promise<string | null> {
  const rows = await sql<{ target: string }>`
    SELECT ft.relname AS target
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'f'
      AND array_length(c.conkey, 1) = 1 AND a.attname = ${column}
  `.execute(app);
  return rows.rows[0]?.target ?? null;
}

async function filler(table: string, column: Column): Promise<unknown> {
  if ((await referencedTable(table, column.name)) === 'users') return newUser();
  const literal = await checkedLiteral(table, column.name);
  if (literal !== null) return literal;
  switch (column.type) {
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
    case 'inet':
      return '192.0.2.1';
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
  for (const column of await columns(table)) {
    if (column.name in row || column.nullable || column.hasDefault) continue;
    row[column.name] = await filler(table, column);
  }
  const names = Object.keys(row);
  await sql`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))})
  `.execute(app);
  return row;
}

export async function newUser(values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insertRow('users', { id, app_id: 'couli', ...values });
  return id;
}

/** Every string literal listed by the CHECK constraints that mention the column. */
export async function checkedLiterals(table: string, column: string): Promise<string[]> {
  const rows = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
  `.execute(app);
  const found: string[] = [];
  for (const { def } of rows.rows) {
    if (!new RegExp(`\\b${column}\\b`).test(def)) continue;
    for (const m of def.matchAll(/'([^']*)'/g)) if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}
