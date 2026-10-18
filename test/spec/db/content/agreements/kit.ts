// F1-02k §9.2 is the schema contract. No application publishing/consent logic here.
// Connections come from *.int.test.ts; fixtures never import another test kit or db/testing.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
export const AT = new Date('2026-10-18T08:00:00.000Z');
export const SHAPE: Record<string, readonly [string, string, string | null]> = {
  id: ['uuid', 'NO', null],
  app_id: ['text', 'NO', null],
  type: ['text', 'NO', null],
  version: ['int4', 'NO', null],
  min_version: ['int4', 'NO', null],
  requires_resign: ['bool', 'NO', null],
  article_id: ['uuid', 'NO', null],
  article_version: ['int4', 'NO', null],
  text_sha256: ['text', 'NO', null],
  url: ['text', 'NO', null],
  legal_confirmed_by: ['text', 'NO', null],
  legal_confirm_note: ['text', 'NO', null],
  published_at: ['timestamptz', 'NO', null],
  published_by: ['uuid', 'NO', null],
  created_at: ['timestamptz', 'NO', 'now()'],
};

export function appId(): string {
  return `ag_${randomUUID().replaceAll('-', '').slice(0, 28)}`;
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
      WHERE table_schema = 'app' AND table_name = 'agreements'
      ORDER BY column_name`.execute(db)
  ).rows;
}

// First assertion in every test: absent migration fails here, never with SQL 42P01.
export async function ready(db: Connection): Promise<void> {
  expect((await columns(db)).map((c) => c.name).sort(), 'app.agreements columns').toEqual(
    Object.keys(SHAPE).sort(),
  );
}

export async function insert(
  db: Connection,
  row: Row,
  table: 'agreements' | 'admin_users' | 'articles' = 'agreements',
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
      password_hash: 'synthetic-agreements-fixture',
      is_super: false,
      status: 'active',
      created_at: AT,
      updated_at: AT,
    },
    'admin_users',
  );
  const article = await insert(
    db,
    {
      id: randomUUID(),
      app_id,
      category: 'agreement',
      title: 'Agreement fixture',
      body: '{"type":"doc","content":[]}',
      version: 1,
      status: 'published',
      published_at: AT,
      notice_closable: true,
      created_at: AT,
      updated_at: AT,
    },
    'articles',
  );
  return {
    id: randomUUID(),
    app_id,
    type: 'privacy',
    version: 1,
    min_version: 1,
    requires_resign: false,
    article_id: article.id,
    article_version: article.version,
    text_sha256: '0'.repeat(64),
    url: 'https://example.test/agreement',
    legal_confirmed_by: 'Fixture legal reviewer',
    legal_confirm_note: 'Fixture publication confirmation',
    published_at: AT,
    published_by: admin.id,
    created_at: AT,
  };
}

export async function rejects(
  run: Promise<unknown>,
  constraint: string,
  code = '23514',
): Promise<void> {
  await expect(run).rejects.toMatchObject({ code, constraint });
}
