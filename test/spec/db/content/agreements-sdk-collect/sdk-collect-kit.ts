// F1-02zzr §9.2–9.3 (D10-465): agreements_type_check widens to sdk_list and collect_list.
// Schema-only contract; publishing/consent rules (F1-02zzs) are out of scope here.
// Connections come from the *.int.test.ts files; this kit imports no other test kit.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
type Accepted = { ok: true; rows: Row[] };
type Refused = { ok: false; code: unknown; constraint: unknown };
export type Outcome = Accepted | Refused;

export const AT = new Date('2026-10-31T08:00:00.000Z');
export const OLD_TYPES = ['privacy', 'agreement', 'labor_agreement'] as const;
export const NEW_TYPES = ['sdk_list', 'collect_list'] as const;
export const TYPES = [...OLD_TYPES, ...NEW_TYPES] as const;

// The other CHECKs of 0045_agreements.sql, as pg_get_constraintdef prints them (db/schema.sql),
// after norm(). They must survive the migration unchanged.
export const OTHER_CHECKS: Record<string, string> = {
  agreements_legal_confirm_check:
    "CHECK (((btrim(legal_confirmed_by) <> ''::text) AND (btrim(legal_confirm_note) <> ''::text)))",
  agreements_min_version_check: 'CHECK (((min_version >= 1) AND (min_version <= version)))',
  agreements_requires_resign_check:
    "CHECK (CASE WHEN (type = 'labor_agreement'::text) THEN (requires_resign = (min_version = version)) ELSE (requires_resign = false) END)",
  agreements_text_sha256_check: "CHECK ((text_sha256 ~ '^[0-9a-f]{64}$'::text))",
  agreements_url_check: "CHECK ((url ~ '^https://'::text))",
  agreements_version_check: 'CHECK ((version >= 1))',
};

/** Collapse layout whitespace of a deparsed constraint definition. */
export function norm(definition: string): string {
  return definition.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

export function appId(): string {
  return `asc_${randomUUID().replaceAll('-', '').slice(0, 27)}`;
}

// First assertion in every test: an absent table fails here, never with SQLSTATE 42P01.
export async function ready(db: Connection): Promise<void> {
  const result = await sql<{ present: boolean }>`SELECT
    to_regclass('app.agreements') IS NOT NULL AS present`.execute(db);
  expect(result.rows, 'app.agreements exists').toEqual([{ present: true }]);
}

function insertSql(db: Connection, row: Row, table: string) {
  const names = Object.keys(row);
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
}

/** Turn a database result into a value, so every SQL failure surfaces as an assertion. */
export async function attempt(run: Promise<{ rows: Row[] }>): Promise<Outcome> {
  try {
    return { ok: true, rows: (await run).rows };
  } catch (error) {
    const failure = error as { code?: unknown; constraint?: unknown };
    return { ok: false, code: failure.code, constraint: failure.constraint };
  }
}

/** Insert an agreement row and report the outcome without throwing. */
export function tryInsert(db: Connection, row: Row): Promise<Outcome> {
  return attempt(insertSql(db, row, 'agreements'));
}

export async function accepts(db: Connection, row: Row, label: string): Promise<void> {
  expect(await tryInsert(db, row), label).toEqual({ ok: true, rows: [row] });
  expect(await stored(db, row), label).toEqual([row]);
}

export async function refuses(
  db: Connection,
  row: Row,
  constraint: string,
  label: string,
  code = '23514',
): Promise<void> {
  expect(await tryInsert(db, row), label).toEqual({ ok: false, code, constraint });
  expect(await stored(db, row), label).toEqual([]);
}

export async function stored(db: Connection, row: Row): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM app.agreements WHERE id = ${row.id}`.execute(db)).rows;
}

/** A valid privacy v1 publication with its own app, admin and article revision. */
export async function fixture(db: Connection): Promise<Row> {
  await ready(db);
  const app_id = appId();
  const admin = await insertSql(
    db,
    {
      id: randomUUID(),
      app_id,
      login_name: app_id,
      password_hash: 'synthetic-sdk-collect-fixture',
      is_super: false,
      status: 'active',
      created_at: AT,
      updated_at: AT,
    },
    'admin_users',
  );
  const article = await insertSql(
    db,
    {
      id: randomUUID(),
      app_id,
      category: 'agreement',
      title: 'SDK / collection list fixture',
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
    article_id: article.rows[0]!.id,
    article_version: article.rows[0]!.version,
    text_sha256: 'ab'.repeat(32),
    url: 'https://example.test/sdk-collect',
    legal_confirmed_by: 'Fixture legal reviewer',
    legal_confirm_note: 'Fixture publication confirmation',
    published_at: AT,
    published_by: admin.rows[0]!.id,
    created_at: AT,
  };
}
