// F1-02zzr §9.3 item 6 (D10-465): the migration changes no grant on app.agreements. Same matrix
// as db/content/agreements/access.int.test.ts for couli_app and couli_readonly.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  NEW_TYPES,
  accepts,
  fixture,
  ready,
  stored,
  tryInsert,
  type Connection,
  type Row,
} from './sdk-collect-kit.ts';

let database: TestDatabase;
let app: Connection;
let readonly: Connection;
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

const PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
] as const;

it('[F1-02zzr#6] app publishes both new types, readonly reads them, and table grants are unchanged', async () => {
  await ready(app);
  const base = await fixture(app);
  const rows: Row[] = NEW_TYPES.map((type) => ({ ...base, id: randomUUID(), type }));
  for (const row of rows) await accepts(app, row, `app inserts ${String(row.type)}`);
  for (const row of rows) {
    expect(await stored(readonly, row), `readonly reads ${String(row.type)}`).toEqual([row]);
    // No new write path for readonly: INSERT is still refused before any constraint runs.
    expect(await tryInsert(readonly, { ...row, id: randomUUID(), version: 2 })).toEqual({
      ok: false,
      code: '42501',
      constraint: undefined,
    });
  }
  for (const role of ['couli_app', 'couli_readonly']) {
    for (const privilege of PRIVILEGES) {
      const allowed = privilege === 'SELECT' || (privilege === 'INSERT' && role === 'couli_app');
      const result = await sql`SELECT
        has_table_privilege(${role}, to_regclass('app.agreements'), ${privilege}) AS allowed,
        has_table_privilege(${role}, to_regclass('app.agreements'), ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
        app,
      );
      expect(result.rows, `${role} ${privilege}`).toEqual([{ allowed, grantable: false }]);
    }
  }
});
