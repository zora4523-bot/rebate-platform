// F1-02q §9.2: schema and permissions only; publication/configuration logic is out of scope.
// Connections are supplied by *.int.test.ts, never imported from db/testing here.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
export const AT = new Date('2026-10-18T08:00:00.000Z');
export const SHAPE: Record<string, readonly [string, string, string | null]> = {
  app_id: ['text', 'NO', null],
  dict: ['text', 'NO', null],
  code: ['text', 'NO', null],
  version: ['int4', 'NO', null],
  text: ['text', 'YES', null],
  created_by: ['uuid', 'NO', null],
  created_at: ['timestamptz', 'NO', 'now()'],
};

export function appId(): string {
  return `di_${randomUUID().replaceAll('-', '').slice(0, 28)}`;
}

export async function columns(db: Connection) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: string;
      defaultValue: string | null;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
        column_default AS "defaultValue"
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'dict_items'
      ORDER BY column_name`.execute(db)
  ).rows;
}

// Missing migration must fail an assertion, not a missing-table SQL error.
export async function ready(db: Connection): Promise<void> {
  expect((await columns(db)).map((c) => c.name).sort(), 'app.dict_items columns').toEqual(
    Object.keys(SHAPE).sort(),
  );
}

export async function articlesReady(db: Connection): Promise<void> {
  const result = await sql`SELECT contype::text AS type, convalidated AS validated
    FROM pg_constraint WHERE conrelid = to_regclass('app.articles')
      AND conname = 'articles_status_check'`.execute(db);
  expect(result.rows, 'validated articles_status_check').toEqual([{ type: 'c', validated: true }]);
}

export async function insert(
  db: Connection,
  row: Row,
  table: 'dict_items' | 'admin_users' | 'articles' = 'dict_items',
): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function fixture(db: Connection): Promise<Row> {
  await ready(db);
  const app_id = appId();
  const admin = await insert(
    db,
    {
      id: randomUUID(),
      app_id,
      login_name: app_id,
      password_hash: 'synthetic-dict-items-fixture',
      is_super: false,
      status: 'active',
      created_at: AT,
      updated_at: AT,
    },
    'admin_users',
  );
  return {
    app_id,
    dict: 'order_status',
    code: 'SETTLED.label',
    version: 1,
    text: 'Settled',
    created_by: admin.id,
    created_at: AT,
  };
}

export function article(): Row {
  return {
    id: randomUUID(),
    app_id: appId(),
    category: 'help',
    title: 'Article fixture',
    body: 'Fixture body',
    version: 1,
    status: 'draft',
    published_at: null,
    notice_closable: true,
    notice_content_version: 1,
    notice_end_at: null,
    row_version: 0,
    created_at: AT,
    updated_at: AT,
  };
}

// F1-02zzc (test-change, transitional; F1-02zt tightens): articles may gain the nullable
// help_section column (docs/changes/20261020 §1.6). Returns null while the column is absent.
export async function helpSectionColumn(
  db: Connection,
): Promise<{ type: string; nullable: boolean; default: string | null } | null> {
  const result = await sql<{
    type: string;
    nullable: string;
    defaultValue: string | null;
  }>`SELECT udt_name AS type, is_nullable AS nullable, column_default AS "defaultValue"
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'articles' AND column_name = 'help_section'`.execute(
    db,
  );
  expect(result.rows.length, 'app.articles.help_section column count').toBeLessThanOrEqual(1);
  const column = result.rows[0];
  if (column === undefined) return null;
  return { type: column.type, nullable: column.nullable === 'YES', default: column.defaultValue };
}

// F1-02zzc (test-change, transitional; F1-02zt tightens): when present, help_section must be
// text, nullable and without default; returns whether the column exists.
export async function helpSectionPresent(db: Connection): Promise<boolean> {
  const column = await helpSectionColumn(db);
  if (column === null) return false;
  expect(column, 'app.articles.help_section shape').toEqual({
    type: 'text',
    nullable: true,
    default: null,
  });
  return true;
}

// F1-02zzc (test-change, transitional; F1-02zt tightens): the full stored row expected for an
// article fixture, with help_section null when the column exists.
export function rowOf(row: Row, present: boolean): Row {
  return present ? { ...row, help_section: null } : { ...row };
}

export async function rejects(
  run: Promise<unknown>,
  constraint: string,
  code = '23514',
): Promise<void> {
  await expect(run).rejects.toMatchObject({ code, constraint });
}
