// F1-06a fixtures use the catalog because the migration and generated DB types do not exist yet.
// Only business-role connections are supplied by the test file. No DDL or privilege changes.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLES = ['admin_users', 'admin_permissions', 'audit_logs'] as const;
export const AT = new Date('2026-10-05T08:00:00Z');

export type Column = { name: string; type: string; nullable: boolean; defaulted: boolean };
export type Key = { columns: string[]; primary: boolean; partial: boolean; expression: boolean };
export type ForeignKey = {
  columns: string[];
  targetSchema: string;
  target: string;
  targetColumns: string[];
  onDelete: string;
  onUpdate: string;
  validated: boolean;
};

export async function columns(db: Kysely<DB>, table: string): Promise<Column[]> {
  const result = await sql<Column>`
    SELECT a.attname AS name, t.typname AS type, NOT a.attnotnull AS nullable,
           (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS defaulted
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'app' AND c.relname = ${table}
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(db);
  // Missing migrations fail by assertion, before any INSERT or regclass cast can fail.
  expect(result.rows.length, `app.${table} exists`).toBeGreaterThan(0);
  return result.rows;
}

export async function column(db: Kysely<DB>, table: string, name: string): Promise<Column> {
  const found = (await columns(db, table)).find((c) => c.name === name);
  expect(found, `${table}.${name} exists`).toBeDefined();
  return found!;
}

export async function keys(db: Kysely<DB>, table: string): Promise<Key[]> {
  await columns(db, table);
  const result = await sql<Key>`
    SELECT ARRAY(SELECT a.attname::text
                 FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
                 LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
                 WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
           i.indisprimary AS primary, (i.indpred IS NOT NULL) AS partial,
           (i.indexprs IS NOT NULL) AS expression
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
      AND i.indisunique AND i.indisvalid AND i.indisready
  `.execute(db);
  return result.rows;
}

export async function foreignKeys(db: Kysely<DB>, table: string): Promise<ForeignKey[]> {
  await columns(db, table);
  const result = await sql<ForeignKey>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(f.conkey) WITH ORDINALITY k(num, ord)
                 JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.num
                 ORDER BY k.ord) AS columns,
           tn.nspname AS "targetSchema", tc.relname AS target,
           ARRAY(SELECT a.attname::text FROM unnest(f.confkey) WITH ORDINALITY k(num, ord)
                 JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.num
                 ORDER BY k.ord) AS "targetColumns",
           f.confdeltype::text AS "onDelete", f.confupdtype::text AS "onUpdate",
           f.convalidated AS validated
    FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class tc ON tc.oid = f.confrelid
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table} AND f.contype = 'f'
  `.execute(db);
  return result.rows;
}

export async function adminReference(db: Kysely<DB>, table: string, name: string): Promise<string> {
  const fk = (await foreignKeys(db, table)).find(
    (f) => f.columns.includes(name) && f.targetSchema === 'app' && f.target === 'admin_users',
  );
  expect(fk, `${table}.${name} references app.admin_users`).toBeDefined();
  const target = fk!.targetColumns[fk!.columns.indexOf(name)];
  expect(target).toBeDefined();
  const primary = (await keys(db, 'admin_users')).find((k) => k.primary);
  expect(primary, 'admin_users primary key').toBeDefined();
  expect(primary!.columns).toContain(target);
  expect(target).not.toBe('app_id');
  return target!;
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : String(error);
  }
}

export async function literals(db: Kysely<DB>, table: string, name: string): Promise<string[]> {
  const checks = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(f.oid) AS def FROM pg_constraint f
    JOIN pg_class c ON c.oid = f.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table} AND f.contype = 'c'
  `.execute(db);
  const enums = await sql<{ label: string }>`
    SELECT e.enumlabel AS label FROM pg_enum e
    JOIN pg_attribute a ON a.atttypid = e.enumtypid
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table} AND a.attname = ${name}
    ORDER BY e.enumsortorder
  `.execute(db);
  return [
    ...enums.rows.map((r) => r.label),
    ...checks.rows
      .filter((r) => new RegExp(`\\b${name}\\b`).test(r.def))
      .flatMap((r) => [...r.def.matchAll(/'([^']*)'/g)].map((m) => m[1]!)),
  ];
}

export function fresh(): string {
  return `fixture_${randomUUID().replaceAll('-', '')}`;
}

export async function insertRow(
  db: Kysely<DB>,
  table: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = { ...values };
  for (const c of await columns(db, table)) {
    if (c.name in row || c.nullable || c.defaulted) continue;
    const allowed = await literals(db, table, c.name);
    if (allowed.length > 0) {
      row[c.name] = allowed[0];
    } else {
      switch (c.type) {
        case 'uuid':
          row[c.name] = randomUUID();
          break;
        case 'bool':
          row[c.name] = false;
          break;
        case 'int2':
        case 'int4':
        case 'int8':
          row[c.name] = 0;
          break;
        case 'timestamptz':
          row[c.name] = AT;
          break;
        case 'inet':
          row[c.name] = '192.0.2.1';
          break;
        case 'json':
        case 'jsonb':
          row[c.name] = '{}';
          break;
        case 'bytea':
          row[c.name] = Buffer.from('synthetic-cipher-v1');
          break;
        default:
          row[c.name] = fresh();
      }
    }
  }
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function newAdmin(db: Kysely<DB>, values: Record<string, unknown> = {}) {
  return insertRow(db, 'admin_users', {
    app_id: 'couli',
    is_super: false,
    totp_secret_cipher: null,
    totp_bound_at: null,
    verify_phone_cipher: null,
    verify_phone_hmac: null,
    verify_phone_set_at: null,
    ...values,
  });
}

export async function newPermission(
  db: Kysely<DB>,
  admin: Record<string, unknown>,
  grantor: Record<string, unknown>,
  values: Record<string, unknown> = {},
) {
  const adminKey = await adminReference(db, 'admin_permissions', 'admin_id');
  const grantorKey = await adminReference(db, 'admin_permissions', 'granted_by');
  return insertRow(db, 'admin_permissions', {
    app_id: 'couli',
    admin_id: admin[adminKey],
    granted_by: grantor[grantorKey],
    permission_key: 'user.list',
    granted_at: AT,
    ...values,
  });
}
