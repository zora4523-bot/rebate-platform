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

// F1-02zzc: articles has the nullable help_section column (docs/changes/20261020 §1.6); it must be
// text, nullable and without default. F1-02zzf：过渡已收紧, the column must exist.
export async function helpSectionReady(db: Connection): Promise<void> {
  const result = await sql<{
    type: string;
    nullable: string;
    defaultValue: string | null;
  }>`SELECT udt_name AS type, is_nullable AS nullable, column_default AS "defaultValue"
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'articles' AND column_name = 'help_section'`.execute(
    db,
  );
  expect(
    result.rows.map((c) => ({
      type: c.type,
      nullable: c.nullable === 'YES',
      default: c.defaultValue,
    })),
    'app.articles.help_section shape',
  ).toEqual([{ type: 'text', nullable: true, default: null }]);
}

// F1-02zzc: the full stored row expected for an article fixture (which writes no help_section), so
// help_section is null. F1-02zzf：过渡已收紧.
export function rowOf(row: Row): Row {
  return { ...row, help_section: null };
}

export async function rejects(
  run: Promise<unknown>,
  constraint: string,
  code = '23514',
): Promise<void> {
  await expect(run).rejects.toMatchObject({ code, constraint });
}
