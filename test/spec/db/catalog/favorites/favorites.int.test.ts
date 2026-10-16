// B1-28a supplemental brief B is the database contract (refs: []).
// No application quota/idempotent-response tests, migration filenames or generated types.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { favorite, insert, privileges, ready, sqlState, type Favorite } from './kit.ts';

let database: TestDatabase | undefined;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let payout: Kysely<DB>;
const connections: Kysely<DB>[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connections.push(app);
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
  connections.push(readonly);
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
  connections.push(payout);
}, 60_000);

afterAll(async () => {
  try {
    await Promise.all(connections.map((connection) => destroyDb(connection)));
  } finally {
    await database?.drop();
  }
}, 60_000);

it('[AC-B1-28a#1] ordinary favorites table has exactly the six required non-null columns', async () => {
  await ready(app);
  const columns = await sql<{ name: string; type: string; nullable: boolean }>`
    SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = to_regclass('app.favorites')
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname
  `.execute(app);
  expect(columns.rows).toEqual([
    { name: 'app_id', type: 'text', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
    { name: 'id', type: 'uuid', nullable: false },
    { name: 'platform', type: 'text', nullable: false },
    { name: 'product_key', type: 'text', nullable: false },
    { name: 'user_id', type: 'uuid', nullable: false },
  ]);
}, 30_000);

it('[AC-B1-28a#2] id is the sole primary key and has no default or generated identity', async () => {
  await ready(app);
  const primary = await sql<{ columns: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
      ORDER BY k.ord) AS columns
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.favorites') AND c.contype = 'p'
  `.execute(app);
  expect(primary.rows).toEqual([{ columns: ['id'] }]);
  const defaults = await sql<{ defaulted: boolean; identity: string; generated: string }>`
    SELECT atthasdef AS defaulted, attidentity::text AS identity, attgenerated::text AS generated
    FROM pg_attribute WHERE attrelid = to_regclass('app.favorites') AND attname = 'id'
  `.execute(app);
  expect(defaults.rows).toEqual([{ defaulted: false, identity: '', generated: '' }]);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  expect(await sqlState(insert(app, { ...favorite(), id: row.id }))).toBe('23505');
  const missing: Record<string, unknown> = { ...favorite() };
  delete missing.id;
  expect(await sqlState(insert(app, missing))).toBe('23502');
}, 30_000);

it('[AC-B1-28a#3] every required column rejects explicit NULL', async () => {
  await ready(app);
  for (const column of ['id', 'app_id', 'user_id', 'platform', 'product_key', 'created_at']) {
    expect(await sqlState(insert(app, { ...favorite(), [column]: null })), column).toBe('23502');
  }
}, 30_000);

it('[AC-B1-28a#4] duplicate tenant/user/platform/product tuple is rejected by a unique constraint', async () => {
  await ready(app);
  const unique = await sql<{ columns: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
      ORDER BY k.ord) AS columns
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.favorites') AND c.contype = 'u'
  `.execute(app);
  expect(unique.rows).toContainEqual({ columns: ['app_id', 'user_id', 'platform', 'product_key'] });
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  expect(await sqlState(insert(app, { ...row, id: randomUUID() }))).toBe('23505');
  const stored = await sql<Favorite>`SELECT * FROM app.favorites WHERE id = ${row.id}`.execute(app);
  expect(stored.rows).toEqual([row]);
}, 30_000);

it('[AC-B1-28a#5] changing each unique-key component independently allows another favorite', async () => {
  await ready(app);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  for (const change of [
    { app_id: `other_${randomUUID()}` },
    { user_id: randomUUID() },
    { platform: 'jd' },
    { product_key: 'tb:0002' },
  ]) {
    expect(await sqlState(insert(app, { ...row, ...change, id: randomUUID() }))).toBe('ok');
  }
}, 30_000);

it('[AC-B1-28a#6] concurrent duplicate inserts persist exactly one favorite', async () => {
  await ready(app);
  const row = favorite();
  const results = await Promise.all([
    sqlState(insert(app, row)),
    sqlState(insert(app, { ...row, id: randomUUID() })),
  ]);
  expect(results.sort()).toEqual(['23505', 'ok']);
  const stored = await sql<{ count: string }>`SELECT count(*)::text AS count FROM app.favorites
    WHERE app_id = ${row.app_id} AND user_id = ${row.user_id}
      AND platform = 'taobao' AND product_key = 'tb:0001'`.execute(app);
  expect(stored.rows).toEqual([{ count: '1' }]);
}, 30_000);

it('[AC-B1-28a#7] usable nonpartial btree index starts with app_id, user_id, created_at DESC', async () => {
  await ready(app);
  // Read key positions, not INCLUDE columns; tolerate names, NULLS ordering and an optional id.
  const indexes = await sql<{ columns: string[]; descending: boolean }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= 3 ORDER BY k.ord) AS columns,
      (i.indoption[2] & 1) = 1 AS descending
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = to_regclass('app.favorites') AND i.indnkeyatts >= 3
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree'
  `.execute(app);
  expect(indexes.rows).toContainEqual({
    columns: ['app_id', 'user_id', 'created_at'],
    descending: true,
  });
}, 30_000);

it('[AC-B1-28a#8] favorites has no foreign keys and accepts a user absent from users', async () => {
  await ready(app);
  const foreignKeys = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
    WHERE conrelid = to_regclass('app.favorites') AND contype = 'f'`.execute(app);
  expect(foreignKeys.rows).toEqual([]);
  const row = favorite();
  const users = await sql`SELECT id FROM app.users WHERE id = ${row.user_id}`.execute(app);
  expect(users.rows).toEqual([]);
  expect(await sqlState(insert(app, row))).toBe('ok');
}, 30_000);

it('[AC-B1-28a#9] couli_app inserts and reads explicit Clock time, physically deletes and recollects', async () => {
  await ready(app);
  expect((await privileges(app)).rows).toEqual([
    { privilege: 'DELETE' },
    { privilege: 'INSERT' },
    { privilege: 'SELECT' },
  ]);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  const stored = await sql<Favorite>`SELECT * FROM app.favorites WHERE id = ${row.id}`.execute(app);
  expect(stored.rows).toEqual([row]);
  const removed = await sql`DELETE FROM app.favorites
    WHERE app_id = ${row.app_id} AND user_id = ${row.user_id} AND id = ${row.id}`.execute(app);
  expect(removed.numAffectedRows).toBe(1n);
  const absent = await sql`SELECT * FROM app.favorites WHERE id = ${row.id}`.execute(app);
  expect(absent.rows).toEqual([]);
  expect(await sqlState(insert(app, { ...row, id: randomUUID() }))).toBe('ok');
}, 30_000);

it('[AC-B1-28a#10] couli_app cannot update any column or truncate', async () => {
  await ready(app);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  for (const [column, value] of Object.entries(row)) {
    expect(
      await sqlState(
        sql`UPDATE app.favorites SET ${sql.ref(column)} = ${value}
        WHERE id = ${row.id}`.execute(app),
      ),
      column,
    ).toBe('42501');
  }
  expect(await sqlState(sql`TRUNCATE TABLE app.favorites`.execute(app))).toBe('42501');
  const stored = await sql<Favorite>`SELECT * FROM app.favorites WHERE id = ${row.id}`.execute(app);
  expect(stored.rows).toEqual([row]);
}, 30_000);

it('[AC-B1-28a#11] couli_readonly can select every column but cannot insert, update, delete or truncate', async () => {
  await ready(app);
  expect((await privileges(readonly)).rows).toEqual([{ privilege: 'SELECT' }]);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  const stored = await sql<Favorite>`SELECT * FROM app.favorites WHERE id = ${row.id}`.execute(
    readonly,
  );
  expect(stored.rows).toEqual([row]);
  expect(await sqlState(insert(readonly, favorite()))).toBe('42501');
  for (const [column, value] of Object.entries(row)) {
    expect(
      await sqlState(
        sql`UPDATE app.favorites SET ${sql.ref(column)} = ${value}
        WHERE id = ${row.id}`.execute(readonly),
      ),
      column,
    ).toBe('42501');
  }
  expect(
    await sqlState(sql`DELETE FROM app.favorites WHERE id = ${row.id}`.execute(readonly)),
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE TABLE app.favorites`.execute(readonly))).toBe('42501');
}, 30_000);

it('[AC-B1-28a#12] couli_payout has no table or column privileges and all data access is denied', async () => {
  await ready(app);
  expect((await privileges(payout)).rows).toEqual([]);
  const row = favorite();
  expect(await sqlState(insert(app, row))).toBe('ok');
  expect(await sqlState(sql`SELECT * FROM app.favorites`.execute(payout))).toBe('42501');
  expect(await sqlState(insert(payout, favorite()))).toBe('42501');
  for (const [column, value] of Object.entries(row)) {
    expect(
      await sqlState(sql`SELECT ${sql.ref(column)} FROM app.favorites`.execute(payout)),
      column,
    ).toBe('42501');
    // No WHERE/RETURNING read: a SELECT denial must not mask an illicit UPDATE grant.
    expect(
      await sqlState(sql`UPDATE app.favorites SET ${sql.ref(column)} = ${value}`.execute(payout)),
      column,
    ).toBe('42501');
  }
  expect(await sqlState(sql`DELETE FROM app.favorites`.execute(payout))).toBe('42501');
  expect(await sqlState(sql`TRUNCATE TABLE app.favorites`.execute(payout))).toBe('42501');
}, 30_000);
