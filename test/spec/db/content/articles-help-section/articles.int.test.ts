// F1-02zq §9.2–9.3; codes from contracts/openapi.yaml ArticleHelpSection (CT-02za).
// The integration globalSetup alone reads the admin database URL and applies migrations.
// Exercise the migrated database through business roles, without fixing a migration number.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

type Row = Record<string, unknown>;
const SECTIONS = [
  'getting_started',
  'rebate_settlement',
  'orders_claims',
  'withdraw',
  'invite',
  'account_privacy',
] as const;
const MUTABLE = ['status', 'published_at', 'notice_end_at', 'row_version', 'updated_at'];
const AT = new Date('2026-10-20T08:00:00.000Z');
let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let sequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});

afterAll(async () => {
  for (const db of [app, readonly]) {
    if (db) await destroyDb(db);
  }
  await database?.drop();
});

async function helpColumn() {
  return (
    await sql`SELECT udt_name AS type, is_nullable AS nullable,
      column_default AS "defaultValue", is_identity AS identity, is_generated AS generated
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'articles'
        AND column_name = 'help_section'`.execute(app)
  ).rows;
}

// Run inside every test: the unmigrated database must fail an assertion, not SQLSTATE 42703.
async function ready(): Promise<void> {
  expect(await helpColumn(), 'app.articles.help_section exists').toHaveLength(1);
}

// Every fixture gets its own app_id; content samples and time are fixed and synthetic.
function article() {
  sequence += 1;
  return {
    id: randomUUID(),
    app_id: `f1_02zq_${sequence}`,
    category: 'help',
    title: 'Help fixture',
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

async function insert(db: Kysely<DB>, row: Row): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO app.articles
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function stored(row: Row, db: Kysely<DB> = app): Promise<Row[]> {
  return (
    await sql<Row>`SELECT * FROM app.articles
      WHERE app_id = ${row.app_id} AND id = ${row.id} ORDER BY version`.execute(db)
  ).rows;
}

it('[AC-F1-02zq#1] help_section is ordinary nullable text without a default', async () => {
  await ready();
  expect(await helpColumn()).toEqual([
    { type: 'text', nullable: 'YES', defaultValue: null, identity: 'NO', generated: 'NEVER' },
  ]);
});

it('[AC-F1-02zq#2] both named help CHECKs are validated and the category/status CHECKs remain', async () => {
  await ready();
  const names = [
    'articles_category_check',
    'articles_help_section_category_check',
    'articles_help_section_check',
    'articles_status_check',
  ];
  const checks = await sql`SELECT conname AS name, contype::text AS type,
    convalidated AS validated FROM pg_constraint
    WHERE conrelid = to_regclass('app.articles') AND conname IN (${sql.join(names)})
    ORDER BY conname`.execute(app);
  expect(checks.rows).toEqual(names.map((name) => ({ name, type: 'c', validated: true })));
});

it('[AC-F1-02zq#3] help accepts and preserves each of the six exact section codes', async () => {
  await ready();
  for (const help_section of SECTIONS) {
    const row = { ...article(), help_section };
    expect(await insert(app, row), help_section).toEqual(row);
    expect(await stored(row), help_section).toEqual([row]);
  }
});

it('[AC-F1-02zq#4] invalid, case-folded and whitespace-padded codes fail the value CHECK', async () => {
  await ready();
  const invalid = [
    '',
    'unknown_section',
    'Invite',
    ...SECTIONS.flatMap((code) => [code.toUpperCase(), `${code} `, ` ${code}`, `${code}\n`]),
  ];
  for (const help_section of invalid) {
    const row = { ...article(), help_section };
    await expect(insert(app, row), JSON.stringify(help_section)).rejects.toMatchObject({
      code: '23514',
      constraint: 'articles_help_section_check',
    });
    expect(await stored(row)).toEqual([]);
  }
});

it('[AC-F1-02zq#5] rule, notice and agreement reject every non-null section via the category CHECK', async () => {
  await ready();
  for (const category of ['rule', 'notice', 'agreement']) {
    for (const help_section of SECTIONS) {
      const row = { ...article(), category, help_section };
      await expect(insert(app, row), `${category}/${help_section}`).rejects.toMatchObject({
        code: '23514',
        constraint: 'articles_help_section_category_check',
      });
      expect(await stored(row)).toEqual([]);
    }
  }
});

it('[AC-F1-02zq#6] every category accepts explicit NULL and legacy inserts omitting help_section', async () => {
  await ready();
  for (const category of ['help', 'rule', 'notice', 'agreement']) {
    const explicit = { ...article(), category, help_section: null };
    expect(await insert(app, explicit)).toEqual(explicit);
    expect(await stored(explicit)).toEqual([explicit]);
    const omitted = { ...article(), category };
    expect(await insert(app, omitted)).toEqual({ ...omitted, help_section: null });
    expect(await stored(omitted)).toEqual([{ ...omitted, help_section: null }]);
  }
});

it('[AC-F1-02zq#7] app and readonly retain their table grants and app UPDATE is exactly the original five columns', async () => {
  await ready();
  for (const role of ['couli_app', 'couli_readonly']) {
    const table = await sql`SELECT
      has_table_privilege(${role}, 'app.articles', 'SELECT') AS select,
      has_table_privilege(${role}, 'app.articles', 'INSERT') AS insert,
      has_table_privilege(${role}, 'app.articles', 'UPDATE') AS update,
      has_table_privilege(${role}, 'app.articles', 'DELETE') AS delete,
      has_table_privilege(${role}, 'app.articles', 'TRUNCATE') AS truncate`.execute(app);
    expect(table.rows, role).toEqual([
      { select: true, insert: role === 'couli_app', update: false, delete: false, truncate: false },
    ]);
    const columns = await sql<{
      name: string;
      select: boolean;
      insert: boolean;
      update: boolean;
      grantable: boolean;
    }>`SELECT attname AS name,
      has_column_privilege(${role}, attrelid, attnum, 'SELECT') AS select,
      has_column_privilege(${role}, attrelid, attnum, 'INSERT') AS insert,
      has_column_privilege(${role}, attrelid, attnum, 'UPDATE') AS update,
      has_column_privilege(${role}, attrelid, attnum, 'UPDATE WITH GRANT OPTION') AS grantable
      FROM pg_attribute WHERE attrelid = to_regclass('app.articles')
        AND attnum > 0 AND NOT attisdropped ORDER BY attname`.execute(app);
    const names = [...Object.keys(article()), 'help_section'].sort();
    expect(columns.rows, role).toEqual(
      names.map((name) => ({
        name,
        select: true,
        insert: role === 'couli_app',
        update: role === 'couli_app' && MUTABLE.includes(name),
        grantable: false,
      })),
    );
  }
});

it('[AC-F1-02zq#8] app cannot UPDATE help_section; a new draft version can carry a different section', async () => {
  await ready();
  for (const initial of [null, 'invite']) {
    const row = { ...article(), help_section: initial };
    await insert(app, row);
    for (const replacement of [null, 'invite', 'withdraw']) {
      await expect(
        sql`UPDATE app.articles SET help_section = ${replacement}
          WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1`.execute(app),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await stored(row)).toEqual([row]);
    }
    const next = { ...row, version: 2, help_section: 'account_privacy' };
    expect(await insert(app, next)).toEqual(next);
    expect(await stored(row)).toEqual([row, next]);
  }
});

it('[AC-F1-02zq#9] each original mutable column remains writable without changing help_section', async () => {
  await ready();
  const row = { ...article(), help_section: 'orders_claims' };
  await insert(app, row);
  const changes: Row = {
    status: 'published',
    published_at: AT,
    notice_end_at: new Date('2026-10-21T08:00:00.000Z'),
    row_version: 1,
    updated_at: new Date('2026-10-20T09:00:00.000Z'),
  };
  const expected: Row = { ...row };
  for (const [column, value] of Object.entries(changes)) {
    const result = await sql<Row>`UPDATE app.articles SET ${sql.ref(column)} = ${value}
      WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1 RETURNING *`.execute(app);
    expected[column] = value;
    expect(result.rows, column).toEqual([expected]);
    expect(await stored(row), column).toEqual([expected]);
  }
});

it('[AC-F1-02zq#10] readonly selects help_section but cannot insert, update any column, delete or truncate', async () => {
  await ready();
  const row = { ...article(), help_section: 'rebate_settlement' };
  await insert(app, row);
  expect(await stored(row, readonly)).toEqual([row]);
  await expect(insert(readonly, { ...row, version: 2 })).rejects.toMatchObject({ code: '42501' });
  for (const column of Object.keys(row)) {
    await expect(
      sql`UPDATE app.articles SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE app_id = ${row.app_id} AND id = ${row.id} AND version = 1`.execute(readonly),
    ).rejects.toMatchObject({ code: '42501' });
  }
  await expect(
    sql`DELETE FROM app.articles WHERE app_id = ${row.app_id} AND id = ${row.id}`.execute(readonly),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(sql`TRUNCATE TABLE app.articles`.execute(readonly)).rejects.toMatchObject({
    code: '42501',
  });
  expect(await stored(row, readonly)).toEqual([row]);
});

it('[AC-F1-02zq#11] existing status and category CHECKs still enforce their values with a null section', async () => {
  await ready();
  for (const status of ['draft', 'published', 'offline']) {
    const row = { ...article(), status, help_section: null };
    expect(await insert(app, row)).toEqual(row);
  }
  for (const status of ['', 'archived', 'Published', 'published ']) {
    await expect(insert(app, { ...article(), status, help_section: null })).rejects.toMatchObject({
      code: '23514',
      constraint: 'articles_status_check',
    });
  }
  for (const category of ['', 'unknown_category', 'Help', 'help ']) {
    await expect(insert(app, { ...article(), category, help_section: null })).rejects.toMatchObject(
      { code: '23514', constraint: 'articles_category_check' },
    );
  }
});
