import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  LATER,
  connect,
  expectCheck,
  fixture,
  insert,
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
const TABLE = 'order_status_history';

it('[AC-B1-08c#19] history has named field and source CHECKs with exactly the task values', async () => {
  await requireTable(app, TABLE);
  await expectCheck(app, TABLE, 'field', ['platform', 'rebate']);
  await expectCheck(app, TABLE, 'source', ['sync', 'admin', 'claim', 'system']);
  for (const field of ['platform', 'rebate']) {
    for (const source of ['sync', 'admin', 'claim', 'system']) {
      const row = await fixture(TABLE, {
        field,
        source,
        event: field === 'platform' ? 'P1' : 'R1',
        to_status: field === 'platform' ? 'PAID' : 'ESTIMATED',
      });
      expect(await sqlState(insert(app, TABLE, row)), `${field}/${source}`).toBe('no error');
    }
  }
  for (const changes of [
    { field: 'other' },
    { field: 'PLATFORM' },
    { field: '' },
    { source: 'worker' },
    { source: 'SYNC' },
    { source: '' },
  ]) {
    expect(await sqlState(insert(app, TABLE, await fixture(TABLE, changes)))).toBe('23514');
  }
});

it('[AC-B1-08c#20] history retains initial NULL from-status and subsequent transitions at injected times', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE);
  const first = await insert(app, TABLE, row);
  expect(first.rows).toEqual([
    expect.objectContaining({
      order_id: row['order_id'],
      field: 'platform',
      from_status: null,
      event: 'P1',
      to_status: 'PAID',
      source: 'sync',
      at: AT,
    }),
  ]);
  const next = await repeat(app, TABLE, row, {
    from_status: 'PAID',
    event: 'P2',
    to_status: 'RECEIVED',
    at: LATER,
  });
  expect(next.rows).toEqual([
    expect.objectContaining({
      order_id: row['order_id'],
      from_status: 'PAID',
      event: 'P2',
      to_status: 'RECEIVED',
      at: LATER,
    }),
  ]);
});

it('[AC-B1-08c#21] history requires an existing order and rejects NULL in required audit fields', async () => {
  await requireTable(app, TABLE);
  const row = await fixture(TABLE);
  expect(await sqlState(insert(app, TABLE, row))).toBe('no error');
  expect(await sqlState(repeat(app, TABLE, row, { order_id: randomUUID() }))).toBe('23503');
  for (const column of ['app_id', 'order_id', 'field', 'event', 'to_status', 'source', 'at']) {
    expect(await sqlState(repeat(app, TABLE, row, { [column]: null })), column).toBe('23502');
  }
});
