import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPES, TABLES, columns, insert, ready, rows, type Connection } from './kit.ts';

let database: TestDatabase;
let app: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  await database?.drop();
});

it('[AC-F1-09a#1] all columns have the declared types, nullability and defaults', async () => {
  await ready(app);
  for (const table of TABLES) {
    expect((await columns(app, table)).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      Object.entries(SHAPES[table])
        .map(([name, [type, nullable, defaultValue]]) => ({ name, type, nullable, defaultValue }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
});

it('[AC-F1-09a#2] omitted values produce draft, zero counters/revision and transaction timestamps', async () => {
  const data = await rows(app);
  delete data.version.created_at;
  delete data.token.created_at;
  await app.transaction().execute(async (trx) => {
    const clock = (
      await sql<{ now: Date; expiry: Date }>`
      SELECT now() AS now, now() + interval '10 minutes' AS expiry`.execute(trx)
    ).rows[0]!;
    const version = await insert(trx, 'page_versions', data.version);
    const page = await insert(trx, 'pages', data.page);
    const token = await insert(trx, 'page_preview_tokens', {
      ...data.token,
      expire_at: clock.expiry,
    });
    expect(version).toMatchObject({
      status: 'draft',
      sections: [],
      render_count: 0n,
      error_count: 0n,
      publish_at: null,
      publisher: null,
      created_at: clock.now,
    });
    expect(page).toMatchObject({
      current_version: null,
      gray_version: null,
      gray_percent: 0,
      revision: 0,
      updated_by_admin_id: null,
      created_at: clock.now,
      updated_at: clock.now,
    });
    expect(token).toMatchObject({ used_count: 0, created_at: clock.now, expire_at: clock.expiry });
  });
});

it('[AC-F1-09a#3] primary keys and checks exist under their prescribed names and are validated', async () => {
  await ready(app);
  const checks = {
    pages: ['page_key', 'gray_percent', 'gray', 'revision'],
    page_versions: ['page_key', 'version', 'sections', 'status', 'counts', 'publish'],
    page_preview_tokens: ['token_hash', 'expire_at', 'used_count'],
  };
  const primary = {
    pages: ['app_id', 'page_key'],
    page_versions: ['app_id', 'page_key', 'version'],
    page_preview_tokens: ['token_hash'],
  };
  for (const table of TABLES) {
    const constraints = await sql<{
      name: string;
      type: string;
      validated: boolean;
      columns: string[];
    }>`
      SELECT c.conname AS name, c.contype::text AS type, c.convalidated AS validated,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
          ORDER BY k.ord) AS columns
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`})
        AND c.contype IN ('p', 'c')`.execute(app);
    expect(constraints.rows.filter((c) => c.type === 'p')).toEqual([
      {
        name: `${table}_pkey`,
        type: 'p',
        validated: true,
        columns: primary[table],
      },
    ]);
    expect(
      constraints.rows
        .filter((c) => c.type === 'c')
        .map(({ name, validated }) => ({ name, validated }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(
      checks[table]
        .map((suffix) => ({ name: `${table}_${suffix}_check`, validated: true }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
});

it('[AC-F1-09a#4] named foreign keys retain full app/page identity and never cascade', async () => {
  await ready(app);
  const expected = [
    [
      'pages',
      'pages_current_version_fkey',
      ['app_id', 'page_key', 'current_version'],
      'page_versions',
      ['app_id', 'page_key', 'version'],
    ],
    [
      'pages',
      'pages_gray_version_fkey',
      ['app_id', 'page_key', 'gray_version'],
      'page_versions',
      ['app_id', 'page_key', 'version'],
    ],
    ['pages', 'pages_updated_by_admin_id_fkey', ['updated_by_admin_id'], 'admin_users', ['id']],
    ['page_versions', 'page_versions_publisher_fkey', ['publisher'], 'admin_users', ['id']],
    [
      'page_versions',
      'page_versions_created_by_admin_id_fkey',
      ['created_by_admin_id'],
      'admin_users',
      ['id'],
    ],
    [
      'page_preview_tokens',
      'page_preview_tokens_version_fkey',
      ['app_id', 'page_key', 'version'],
      'page_versions',
      ['app_id', 'page_key', 'version'],
    ],
    [
      'page_preview_tokens',
      'page_preview_tokens_created_by_fkey',
      ['created_by'],
      'admin_users',
      ['id'],
    ],
  ] as const;
  const result = await sql<{
    table: string;
    name: string;
    columns: string[];
    target: string;
    targetSchema: string;
    targetColumns: string[];
    onDelete: string;
    onUpdate: string;
    match: string;
    validated: boolean;
  }>`SELECT t.relname AS table, c.conname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      target.relname AS target, ns.nspname AS "targetSchema",
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS "targetColumns",
      c.confdeltype::text AS "onDelete", c.confupdtype::text AS "onUpdate",
      c.confmatchtype::text AS match, c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace src ON src.oid = t.relnamespace
    JOIN pg_class target ON target.oid = c.confrelid JOIN pg_namespace ns ON ns.oid = target.relnamespace
    WHERE src.nspname = 'app' AND t.relname IN (${sql.join(TABLES)}) AND c.contype = 'f'
    ORDER BY c.conname`.execute(app);
  expect(result.rows).toEqual(
    expected
      .map(([table, name, columns, target, targetColumns]) => ({
        table,
        name,
        columns: [...columns],
        target,
        targetSchema: 'app',
        targetColumns: [...targetColumns],
        onDelete: 'a',
        onUpdate: 'a',
        match: 's',
        validated: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

it('[AC-F1-09a#5] ordinary tables have no user triggers, partitions or secondary indexes', async () => {
  await ready(app);
  for (const table of TABLES) {
    const kind = await sql`SELECT relkind::text AS kind, relispartition AS partition
      FROM pg_class WHERE oid = to_regclass(${`app.${table}`})`.execute(app);
    expect(kind.rows).toEqual([{ kind: 'r', partition: false }]);
    // PostgreSQL's internal foreign-key triggers are expected, user triggers are not.
    const triggers = await sql`SELECT tgname FROM pg_trigger
      WHERE tgrelid = to_regclass(${`app.${table}`}) AND NOT tgisinternal`.execute(app);
    expect(triggers.rows).toEqual([]);
    const indexes =
      await sql`SELECT indisprimary AS primary, indisvalid AS valid, indisready AS ready
      FROM pg_index WHERE indrelid = to_regclass(${`app.${table}`})`.execute(app);
    expect(indexes.rows).toEqual([{ primary: true, valid: true, ready: true }]);
  }
});
