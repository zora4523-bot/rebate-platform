import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPE, columns, fixture, insert, ready, type Connection } from './kit.ts';

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

it('[AC-F1-02q#1] dict_items has exactly the specified column types, nullability and defaults', async () => {
  await ready(app);
  expect(await columns(app)).toEqual(
    Object.entries(SHAPE)
      .map(([name, [type, nullable, defaultValue]]) => ({ name, type, nullable, defaultValue }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const generated = await sql`SELECT attname FROM pg_attribute
    WHERE attrelid = to_regclass('app.dict_items') AND attnum > 0 AND NOT attisdropped
      AND (attidentity <> '' OR attgenerated <> '')`.execute(app);
  expect(generated.rows).toEqual([]);
});

it('[AC-F1-02q#2] created_at defaults to transaction time and nullable text preserves fallback', async () => {
  const row = await fixture(app);
  delete row.created_at;
  await app.transaction().execute(async (trx) => {
    const clock = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    expect(await insert(trx, { ...row, text: null })).toEqual({
      ...row,
      text: null,
      created_at: clock.rows[0]!.now,
    });
  });
});

it('[AC-F1-02q#3] the named four-column primary key and both checks are validated', async () => {
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
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.dict_items')
      AND c.contype IN ('p', 'u', 'c') ORDER BY c.conname`.execute(app);
  expect(result.rows.filter((c) => c.type === 'p')).toEqual([
    {
      name: 'dict_items_pkey',
      type: 'p',
      validated: true,
      columns: ['app_id', 'dict', 'code', 'version'],
    },
  ]);
  expect(result.rows.filter((c) => c.type === 'u')).toEqual([]);
  expect(
    result.rows.filter((c) => c.type === 'c').map(({ name, validated }) => ({ name, validated })),
  ).toEqual([
    { name: 'dict_items_dict_check', validated: true },
    { name: 'dict_items_version_check', validated: true },
  ]);
});

it('[AC-F1-02q#4] creator references admin_users.id without cascading', async () => {
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
    WHERE c.conrelid = to_regclass('app.dict_items') AND c.contype = 'f'`.execute(app);
  expect(
    result.rows.map(({ onDelete, onUpdate, ...fk }) => {
      expect(['a', 'r']).toContain(onDelete);
      expect(['a', 'r']).toContain(onUpdate);
      return fk;
    }),
  ).toEqual([
    {
      name: 'dict_items_created_by_fkey',
      columns: ['created_by'],
      targetSchema: 'app',
      target: 'admin_users',
      targetColumns: ['id'],
      validated: true,
    },
  ]);
});

it('[AC-F1-02q#5] dict_items is an ordinary table with only its primary index and no user triggers', async () => {
  await ready(app);
  const table = await sql`SELECT relkind::text AS kind, relispartition AS partition
    FROM pg_class WHERE oid = to_regclass('app.dict_items')`.execute(app);
  expect(table.rows).toEqual([{ kind: 'r', partition: false }]);
  const indexes = await sql`SELECT indisprimary AS primary, indisvalid AS valid
    FROM pg_index WHERE indrelid = to_regclass('app.dict_items')`.execute(app);
  expect(indexes.rows).toEqual([{ primary: true, valid: true }]);
  const triggers = await sql`SELECT tgname FROM pg_trigger
    WHERE tgrelid = to_regclass('app.dict_items') AND NOT tgisinternal`.execute(app);
  expect(triggers.rows).toEqual([]);
});
