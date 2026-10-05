// B1-19a fixtures: raw SQL keeps the red phase independent of generated database types.
// Only unspecified fixture columns are inferred; expected business values live in the tests.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLES = ['union_accounts', 'union_credentials', 'union_pids'] as const;
export type Table = (typeof TABLES)[number];
export const AT = new Date('2026-10-05T01:00:00Z');
export const EXPIRES = new Date('2027-01-03T01:00:00Z');
// Synthetic envelope bytes, no real token/key. SQL stores the platform/crypto v1 envelope
// opaquely; encryption correctness belongs to the existing platform crypto rule tests.
export const CIPHER = `v1.1.${Buffer.alloc(40, 7).toString('base64url')}`;
export type Column = { name: string; type: string; nullable: boolean; has_default: boolean };
export type ForeignKey = {
  columns: string[];
  target_schema: string;
  target: string;
  target_columns: string[];
  on_delete: string;
  on_update: string;
};

export async function columns(db: Kysely<DB>, table: Table): Promise<Column[]> {
  const result = await sql<Column>`
    SELECT a.attname AS name, t.typname AS type, NOT a.attnotnull AS nullable,
           (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = to_regclass(${`app.${table}`}) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(db);
  // Missing migrations must fail assertions, never leak a missing-relation SQL error.
  expect(result.rows.length, `app.${table} exists`).toBeGreaterThan(0);
  return result.rows;
}

export async function foreignKeys(db: Kysely<DB>, table: Table): Promise<ForeignKey[]> {
  await columns(db, table);
  const result = await sql<ForeignKey>`
    SELECT ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
             ORDER BY k.ord) AS columns,
           n.nspname AS target_schema, t.relname AS target,
           ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
             ORDER BY k.ord) AS target_columns,
           c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'
  `.execute(db);
  return result.rows;
}

export async function accountKey(db: Kysely<DB>, table: Table): Promise<ForeignKey> {
  const key = (await foreignKeys(db, table)).find(
    (fk) => fk.target_schema === 'app' && fk.target === 'union_accounts',
  );
  expect(key, `${table} retains its union_accounts foreign key`).toBeDefined();
  return key!;
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    // Do not disguise assertion failures, TypeErrors or other fixture defects as SQL failures.
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) throw error;
    return code;
  }
}

export function pidScenes(): string[] {
  const source = readFileSync(
    new URL('../../../../contracts/enums/trade.yaml', import.meta.url),
    'utf8',
  );
  const block = /^  pid_scene:\n([\s\S]*?)(?=^  \w+:)/m.exec(source)?.[1] ?? '';
  const values = [...block.matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!);
  expect(values.length, 'contracts/enums/trade.yaml pid_scene values').toBeGreaterThan(0);
  return values;
}

export function cipherColumns(cols: Column[]): Column[] {
  // The task specifies encrypted storage, not the names of its ciphertext columns.
  return cols.filter((c) => /cipher|encrypt/.test(c.name));
}

function filler(col: Column): unknown {
  if (/cipher|encrypt/.test(col.name)) return col.type === 'bytea' ? Buffer.from(CIPHER) : CIPHER;
  switch (col.type) {
    case 'uuid':
      return randomUUID();
    case 'int2':
    case 'int4':
    case 'int8':
      return 1;
    case 'bool':
      return true;
    case 'timestamptz':
      return AT;
    case 'bytea':
      return Buffer.from('synthetic-fixture');
    case 'jsonb':
      return '{}';
    default:
      return `fixture-${randomUUID()}`;
  }
}

export async function insertRow(
  db: Kysely<DB>,
  table: Table,
  overrides: Record<string, unknown> = {},
  omit: string[] = [],
): Promise<Record<string, unknown>> {
  const cols = await columns(db, table);
  const defaults: Record<string, unknown> =
    table === 'union_accounts'
      ? {
          platform: 'jd',
          status: 'fixture-status',
          sync_start_at: AT,
          auth_expires_at: EXPIRES,
          auth_status: 'active',
          alert_stage: 'none',
        }
      : table === 'union_pids'
        ? { platform: 'jd', pid: `fixture-${randomUUID()}`, site_id: null, pid_scene: 'self_buy' }
        : { expires_at: EXPIRES };
  const row: Record<string, unknown> = { app_id: 'couli', ...defaults, ...overrides };
  if (cols.some((col) => col.name === 'platform') && !('platform' in row)) row['platform'] = 'jd';
  if (table !== 'union_accounts') {
    const key = await accountKey(db, table);
    if (key.columns.some((name) => name !== 'app_id' && !(name in row))) {
      const parent = await insertRow(db, 'union_accounts', {
        app_id: row['app_id'] ?? 'couli',
        platform: row['platform'] ?? 'jd',
      });
      key.columns.forEach((name, i) => {
        if (!(name in row)) row[name] = parent[key.target_columns[i]!];
      });
    }
  }
  for (const col of cols) {
    if (col.name in row || omit.includes(col.name)) continue;
    if (/cipher|encrypt/.test(col.name) || (!col.nullable && !col.has_default))
      row[col.name] = filler(col);
  }
  for (const name of omit) delete row[name];
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}
