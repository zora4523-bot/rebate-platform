// Shared helpers of the F1-02a content and configuration rule tests (adapted from
// test/spec/db/linking/kit.ts: rule-test files are add-only, so each task keeps its own copy).
// Integers are filled with 1 (notice_content_version is ≥ 1, 规划/04 §6.2 NoticeItem) and json
// columns with an empty array (app_versions.store_listings is a jsonb array, 04 §3.2).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

export type Column = {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  default: string | null;
};

const columnCache = new Map<string, Column[]>();

export async function columns(table: string): Promise<Column[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = await sql<{
    name: string;
    type: string;
    nullable: string;
    has_default: boolean;
    default: string | null;
  }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
           (column_default IS NOT NULL OR is_identity = 'YES' OR is_generated = 'ALWAYS')
             AS has_default,
           column_default AS default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY ordinal_position
  `.execute(app);
  const list = rows.rows.map((r) => ({
    name: r.name,
    type: r.type,
    nullable: r.nullable === 'YES',
    hasDefault: r.has_default,
    default: r.default,
  }));
  columnCache.set(table, list);
  return list;
}

export async function column(table: string, name: string): Promise<Column | undefined> {
  return (await columns(table)).find((c) => c.name === name);
}

/**
 * Fixed, valid values for columns whose format a CHECK may constrain (semantic version strings of
 * app_versions, 04 §3.2; client platforms of contracts/enums/platform.yaml client_platform).
 */
const FIXED: Readonly<Record<string, unknown>> = {
  latest_version: '1.2.0',
  min_supported_version: '1.0.0',
  recommended_version: '1.1.0',
  platform: 'android',
};

/**
 * A value of an enumeration CHECK on the column (`col = ANY (ARRAY['a'::text, ...])`), if any.
 * Format checks (regular expressions, lengths) are never mined for a value: a literal there is a
 * pattern, not a valid value.
 */
async function enumeratedLiteral(table: string, name: string): Promise<string | null> {
  const rows = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'app' AND t.relname = ${table} AND c.contype = 'c'
  `.execute(app);
  const pattern = new RegExp(`\\(?${name}\\)? = ANY \\(\\(?ARRAY\\['([^']*)'::text`);
  for (const { def } of rows.rows) {
    const literal = pattern.exec(def);
    if (literal?.[1] !== undefined) return literal[1];
  }
  return null;
}

async function filler(table: string, col: Column): Promise<unknown> {
  if (col.name in FIXED) return FIXED[col.name];
  switch (col.type) {
    case 'uuid':
      return randomUUID();
    case 'int2':
    case 'int4':
    case 'int8':
    case 'numeric':
      return 1;
    case 'bool':
      return false;
    case 'timestamptz':
    case 'timestamp':
      return new Date('2026-10-01T00:00:00Z');
    case 'date':
      return '2026-10-01';
    case 'jsonb':
    case 'json':
      return '[]';
    default:
      return (await enumeratedLiteral(table, col.name)) ?? unique('v');
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

export const SEEDS_DIR = fileURLToPath(new URL('../../../../db/seeds/', import.meta.url));

/**
 * Seed files that write config_items, in file-name order (the order of packages/db/scripts/seed.ts).
 * Tests cannot connect as couli_migrator (packages/db/src/testing/context.ts), so the files run as
 * couli_app, each in its own transaction like seed.ts does; couli_app holds INSERT on config_items,
 * which is all an INSERT … ON CONFLICT DO NOTHING needs.
 */
export function configSeedFiles(): { name: string; text: string }[] {
  return readdirSync(SEEDS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(`${SEEDS_DIR}${name}`, 'utf8') }))
    .filter(({ text }) => /\bconfig_items\b/.test(text));
}

export async function runConfigSeeds(): Promise<void> {
  for (const { text } of configSeedFiles()) {
    await app.transaction().execute(async (trx) => {
      await sql.raw(text).execute(trx);
    });
  }
}
