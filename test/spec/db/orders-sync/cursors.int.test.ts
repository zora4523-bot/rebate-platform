import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  LATER,
  connect,
  expectUnique,
  fixture,
  insert,
  newAccount,
  repeat,
  requireTable,
  sqlState,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});
const TABLE = 'sync_cursors';

it('[AC-B1-08c#5] the stream unique constraint includes tenant, platform, account, query and scene', async () => {
  await requireTable(app, TABLE);
  await expectUnique(app, TABLE, ['app_id', 'platform', 'union_account_id', 'query_kind', 'scene']);
  const row = await fixture(TABLE);
  expect(await sqlState(insert(app, TABLE, row))).toBe('no error');
  expect(await sqlState(repeat(app, TABLE, row))).toBe('23505');
  for (const changes of [
    { query_kind: 'created_at' },
    { scene: '2' },
    { union_account_id: await newAccount() },
    { platform: 'jd', union_account_id: await newAccount('couli', 'jd') },
    { app_id: 'couli_two', union_account_id: await newAccount('couli_two') },
  ]) {
    expect(await sqlState(repeat(app, TABLE, row, changes))).toBe('no error');
  }
});

it('[AC-B1-08c#6] a missing union account fails with 23503, required stream fields reject NULL', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE);
  expect(await sqlState(insert(app, TABLE, row))).toBe('no error');
  expect(await sqlState(repeat(app, TABLE, row, { union_account_id: randomUUID() }))).toBe('23503');
  for (const column of [
    'app_id',
    'platform',
    'union_account_id',
    'query_kind',
    'scene',
    'cursor_at',
    'updated_at',
  ]) {
    expect(await sqlState(repeat(app, TABLE, row, { [column]: null })), column).toBe('23502');
  }
});

it('[AC-B1-08c#7] one stream can advance its application-supplied watermark without touching another scene', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE);
  expect(await sqlState(insert(app, TABLE, row))).toBe('no error');
  expect(await sqlState(repeat(app, TABLE, row, { scene: '2' }))).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.sync_cursors SET cursor_at = ${LATER}, updated_at = ${LATER}
    WHERE app_id = ${row['app_id']} AND union_account_id = ${row['union_account_id']}
      AND query_kind = ${row['query_kind']} AND scene = '-'`.execute(app),
    ),
  ).toBe('no error');
  const stored = await sql<{ scene: string; cursor_at: Date; updated_at: Date }>`
    SELECT scene, cursor_at, updated_at FROM app.sync_cursors
    WHERE union_account_id = ${row['union_account_id']} ORDER BY scene
  `.execute(app);
  expect(stored.rows).toEqual([
    { scene: '-', cursor_at: LATER, updated_at: LATER },
    { scene: '2', cursor_at: AT, updated_at: AT },
  ]);
});
