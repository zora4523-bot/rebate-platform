// F1-09a §9.2 is the schema contract. Application publishing, CAS, bucketing and
// automatic rollback are outside this migration task. No generated DB types needed.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { newAdmin } from '../../admin/kit.ts';

export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
export const TABLES = ['pages', 'page_versions', 'page_preview_tokens'] as const;
export type Table = (typeof TABLES)[number];
type Shape = Record<string, readonly [type: string, nullable: string, defaultValue: string | null]>;
export const SHAPES: Record<Table, Shape> = {
  pages: {
    app_id: ['text', 'NO', null],
    page_key: ['text', 'NO', null],
    current_version: ['int4', 'YES', null],
    gray_version: ['int4', 'YES', null],
    gray_percent: ['int2', 'NO', '0'],
    revision: ['int4', 'NO', '0'],
    updated_by_admin_id: ['uuid', 'YES', null],
    scheduled_version: ['int4', 'YES', null],
    scheduled_gray_percent: ['int2', 'YES', null],
    scheduled_at: ['timestamptz', 'YES', null],
    scheduled_by_admin_id: ['uuid', 'YES', null],
    created_at: ['timestamptz', 'NO', 'now()'],
    updated_at: ['timestamptz', 'NO', 'now()'],
  },
  page_versions: {
    app_id: ['text', 'NO', null],
    page_key: ['text', 'NO', null],
    version: ['int4', 'NO', null],
    sections: ['jsonb', 'NO', null],
    status: ['text', 'NO', "'draft'::text"],
    render_count: ['int8', 'NO', '0'],
    error_count: ['int8', 'NO', '0'],
    publish_at: ['timestamptz', 'YES', null],
    publisher: ['uuid', 'YES', null],
    created_by_admin_id: ['uuid', 'NO', null],
    created_at: ['timestamptz', 'NO', 'now()'],
  },
  page_preview_tokens: {
    token_hash: ['text', 'NO', null],
    app_id: ['text', 'NO', null],
    page_key: ['text', 'NO', null],
    version: ['int4', 'NO', null],
    created_by: ['uuid', 'NO', null],
    created_at: ['timestamptz', 'NO', 'now()'],
    expire_at: ['timestamptz', 'NO', null],
    used_count: ['int4', 'NO', '0'],
  },
};
export const AT = new Date('2026-10-17T08:00:00.000Z');
export const EXPIRES = new Date('2026-10-17T08:10:00.000Z');
export const UPDATABLE: Record<Table, string[]> = {
  pages: [
    'current_version',
    'gray_version',
    'gray_percent',
    'revision',
    'updated_by_admin_id',
    'updated_at',
    'scheduled_version',
    'scheduled_gray_percent',
    'scheduled_at',
    'scheduled_by_admin_id',
  ],
  page_versions: ['status', 'publish_at', 'publisher', 'render_count', 'error_count'],
  page_preview_tokens: ['used_count'],
};

export function appId(): string {
  return `pages_${randomUUID().replaceAll('-', '')}`;
}

export function tokenHash(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
}

export async function columns(db: Connection, table: Table) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: string;
      defaultValue: string | null;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
      column_default AS "defaultValue"
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY ordinal_position`.execute(db)
  ).rows;
}

// Every test calls this before touching the absent tables. The unimplemented
// migration must fail an assertion, never SQL 42P01 or an undefined-column error.
export async function ready(db: Connection): Promise<void> {
  for (const table of TABLES) {
    expect((await columns(db, table)).map((c) => c.name).sort(), `app.${table} columns`).toEqual(
      Object.keys(SHAPES[table]).sort(),
    );
  }
}

export async function insert(db: Connection, table: Table, row: Row): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function update(db: Connection, table: Table, key: Row, changes: Row): Promise<Row> {
  const result = await sql<Row>`UPDATE ${sql.table(`app.${table}`)}
    SET ${sql.join(Object.entries(changes).map(([k, v]) => sql`${sql.ref(k)} = ${v}`))}
    WHERE ${sql.join(
      Object.entries(key).map(([k, v]) => sql`${sql.ref(k)} = ${v}`),
      sql` AND `,
    )}
    RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function rows(db: Connection) {
  await ready(db);
  const id = appId();
  const admin = await newAdmin(db, { app_id: id });
  const version: Row = {
    app_id: id,
    page_key: 'home',
    version: 1,
    sections: '[]',
    created_by_admin_id: admin.id,
    created_at: AT,
  };
  const page: Row = { app_id: id, page_key: 'home' };
  const token: Row = {
    token_hash: tokenHash(),
    app_id: id,
    page_key: 'home',
    version: 1,
    created_by: admin.id,
    created_at: AT,
    expire_at: EXPIRES,
  };
  return { admin, version, page, token };
}

export async function seeded(db: Connection) {
  const data = await rows(db);
  await insert(db, 'page_versions', data.version);
  await insert(db, 'page_versions', { ...data.version, version: 2 });
  return data;
}

export async function rejects(
  run: Promise<unknown>,
  constraint: string,
  code = '23514',
): Promise<void> {
  await expect(run).rejects.toMatchObject({ code, constraint });
}
