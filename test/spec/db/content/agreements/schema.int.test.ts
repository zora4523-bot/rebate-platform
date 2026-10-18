import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AT, SHAPE, columns, fixture, insert, ready, type Connection } from './kit.ts';

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

it('[AC-F1-02k#1] exact columns, types, nullability and defaults; no status or body', async () => {
  await ready(app);
  expect((await columns(app)).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
    Object.entries(SHAPE)
      .map(([name, [type, nullable, defaultValue]]) => ({ name, type, nullable, defaultValue }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const generated = await sql`SELECT attname FROM pg_attribute
    WHERE attrelid = to_regclass('app.agreements') AND attnum > 0 AND NOT attisdropped
      AND (attidentity <> '' OR attgenerated <> '')`.execute(app);
  expect(generated.rows).toEqual([]);
});

it('[AC-F1-02k#2] created_at defaults to transaction time; published_at preserves supplied clock', async () => {
  const row = await fixture(app);
  delete row.created_at;
  await app.transaction().execute(async (trx) => {
    const clock = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    expect(await insert(trx, row)).toMatchObject({
      ...row,
      published_at: AT,
      created_at: clock.rows[0]!.now,
    });
  });
});

it('[AC-F1-02k#3] primary key, tenant/type/version uniqueness and all named checks are validated', async () => {
  await ready(app);
  const result = await sql<{
    name: string;
    type: string;
    validated: boolean;
    columns: string[];
  }>`SELECT c.conname AS name, c.contype::text AS type, c.convalidated AS validated,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS columns
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.agreements')
      AND c.contype IN ('p', 'u', 'c')`.execute(app);
  expect(
    result.rows
      .filter((c) => c.type === 'p')
      .map(({ columns, validated }) => ({
        columns,
        validated,
      })),
  ).toEqual([{ columns: ['id'], validated: true }]);
  expect(result.rows.filter((c) => c.type === 'u')).toEqual([
    {
      name: 'agreements_app_type_version_key',
      type: 'u',
      validated: true,
      columns: ['app_id', 'type', 'version'],
    },
  ]);
  expect(
    result.rows
      .filter((c) => c.type === 'c')
      .map(({ name, validated }) => ({
        name,
        validated,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual(
    ['type', 'version', 'min_version', 'requires_resign', 'text_sha256', 'url', 'legal_confirm']
      .map((suffix) => ({ name: `agreements_${suffix}_check`, validated: true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

it('[AC-F1-02k#4] named foreign keys retain article revision and publisher identity without cascading', async () => {
  await ready(app);
  const result = await sql<{
    name: string;
    columns: string[];
    targetSchema: string;
    target: string;
    targetColumns: string[];
    onDelete: string;
    onUpdate: string;
    validated: boolean;
  }>`SELECT c.conname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.ord) AS columns,
      ns.nspname AS "targetSchema", t.relname AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.ord) AS "targetColumns",
      c.confdeltype::text AS "onDelete", c.confupdtype::text AS "onUpdate",
      c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE c.conrelid = to_regclass('app.agreements') AND c.contype = 'f'
    ORDER BY c.conname`.execute(app);
  expect(
    result.rows.map(({ onDelete, onUpdate, ...fk }) => {
      expect(['a', 'r']).toContain(onDelete);
      expect(['a', 'r']).toContain(onUpdate);
      return fk;
    }),
  ).toEqual([
    {
      name: 'agreements_article_fkey',
      columns: ['article_id', 'article_version'],
      targetSchema: 'app',
      target: 'articles',
      targetColumns: ['id', 'version'],
      validated: true,
    },
    {
      name: 'agreements_published_by_fkey',
      columns: ['published_by'],
      targetSchema: 'app',
      target: 'admin_users',
      targetColumns: ['id'],
      validated: true,
    },
  ]);
});

it('[AC-F1-02k#5] agreements is an ordinary table without user triggers', async () => {
  await ready(app);
  const kind = await sql`SELECT relkind::text AS kind, relispartition AS partition
    FROM pg_class WHERE oid = to_regclass('app.agreements')`.execute(app);
  expect(kind.rows).toEqual([{ kind: 'r', partition: false }]);
  const triggers = await sql`SELECT tgname FROM pg_trigger
    WHERE tgrelid = to_regclass('app.agreements') AND NOT tgisinternal`.execute(app);
  expect(triggers.rows).toEqual([]);
});
