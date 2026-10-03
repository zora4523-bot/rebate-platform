// Additions after the rule-test review round 1 of B1-02a (Codex, out_of_scope entries that
// belong to this task's tables; 规划/04 §3.2 users, devices, device_registrations; BR-INV-05,
// BR-ID-09 细则「设备标识的无效值」, BR-ID-05 细则「同设备注册上限的计数」). Real PostgreSQL as
// couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  checkedLiterals,
  columns,
  hex64,
  insertRow,
  newUser,
  sqlState,
  unique,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

/**
 * Values for a normal (not deleting, not deleted) account: the status literal the CHECK lists
 * besides deleting and deleted, or nothing when the column has a default and no CHECK.
 */
async function normalStatus(): Promise<Record<string, unknown>> {
  const listed = (await checkedLiterals('users', 'status')).filter(
    (v) => v !== 'deleting' && v !== 'deleted',
  );
  if (listed[0] !== undefined) return { status: listed[0] };
  const status = (await columns('users')).find((c) => c.name === 'status');
  expect(status?.hasDefault, 'users.status needs a CHECK listing its values or a default').toBe(
    true,
  );
  return {};
}

it('[AC-B1-02a#17] two normal accounts never share a phone_hmac (BR-INV-05)', async () => {
  const hmac = unique('hmac-');
  const normal = await normalStatus();
  await newUser({ phone_hmac: hmac, ...normal });
  expect(await sqlState(newUser({ phone_hmac: hmac, ...normal }))).toBe(UNIQUE_VIOLATION);
  // An account in deletion also keeps the number from a normal one, and the other way round.
  expect(await sqlState(newUser({ phone_hmac: hmac, status: 'deleting' }))).toBe(UNIQUE_VIOLATION);
  const other = unique('hmac-');
  await newUser({ phone_hmac: other, status: 'deleting' });
  expect(await sqlState(newUser({ phone_hmac: other, ...normal }))).toBe(UNIQUE_VIOLATION);
  // A finally deleted account frees the number for a new normal account.
  const freed = unique('hmac-');
  await newUser({ phone_hmac: freed, status: 'deleted' });
  expect(await sqlState(newUser({ phone_hmac: freed, ...normal }))).toBe('no error');
});

it('[AC-B1-02a#18] devices.device_hash longer than 64 characters is rejected', async () => {
  for (const bad of [`${hex64()}a`, 'a'.repeat(65), `${hex64()}${hex64()}`]) {
    expect(
      await sqlState(
        insertRow('devices', { app_id: 'couli', device_hash: bad, id_source: 'idfv' }),
      ),
      String(bad.length),
    ).toBe(CHECK_VIOLATION);
  }
});

it('[AC-B1-02a#19] registration records keep app_id, register_method and created_at', async () => {
  const user = await newUser();
  const row = await insertRow('device_registrations', {
    app_id: 'couli',
    device_hash: hex64(),
    user_id: user,
  });
  const before = await sql<Record<string, unknown>>`
    SELECT app_id, register_method, created_at FROM app.device_registrations
    WHERE user_id = ${user}
  `.execute(app);
  const current = String(before.rows[0]?.['register_method']);
  const another =
    (await checkedLiterals('device_registrations', 'register_method')).find((v) => v !== current) ??
    `${current}-changed`;
  const attempts = [
    sql`UPDATE app.device_registrations SET created_at = created_at - interval '31 days'
        WHERE user_id = ${user}`,
    sql`UPDATE app.device_registrations SET app_id = 'couli_two' WHERE user_id = ${user}`,
    sql`UPDATE app.device_registrations SET register_method = ${another}
        WHERE user_id = ${user}`,
  ];
  for (const attempt of attempts) {
    expect(await sqlState(attempt.execute(app))).not.toBe('no error');
  }
  const after = await sql<Record<string, unknown>>`
    SELECT app_id, register_method, created_at FROM app.device_registrations
    WHERE user_id = ${user}
  `.execute(app);
  expect(after.rows).toEqual(before.rows);
  expect(row['user_id']).toBe(user);
});
