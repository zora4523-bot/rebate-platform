// F1-06o §9.2: adding login-state grants must preserve the baseline column grants.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns } from '../kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

it('[AC-F1-06o#12] adding login-state grants preserves existing admin_users column access', async () => {
  const found = await columns(app, 'admin_users');
  // This regression case must also fail by assertion before the new migration exists.
  for (const name of ['password_must_change', 'failed_login_count', 'locked_until']) {
    expect(
      found.map((c) => c.name),
      `app.admin_users.${name} exists`,
    ).toContain(name);
  }

  // Expected access comes from the existing schema, not from the migration under test.
  const baseline = [
    { name: 'id', appUpdate: false, readonlySelect: true },
    { name: 'app_id', appUpdate: false, readonlySelect: true },
    { name: 'login_name', appUpdate: false, readonlySelect: true },
    { name: 'password_hash', appUpdate: true, readonlySelect: false },
    { name: 'totp_secret_cipher', appUpdate: true, readonlySelect: false },
    { name: 'totp_bound_at', appUpdate: true, readonlySelect: true },
    { name: 'totp_last_step', appUpdate: true, readonlySelect: true },
    { name: 'is_super', appUpdate: true, readonlySelect: true },
    { name: 'status', appUpdate: true, readonlySelect: true },
    { name: 'verify_phone_cipher', appUpdate: true, readonlySelect: false },
    { name: 'verify_phone_hmac', appUpdate: true, readonlySelect: false },
    { name: 'verify_phone_set_at', appUpdate: true, readonlySelect: true },
    { name: 'row_version', appUpdate: true, readonlySelect: true },
    { name: 'created_at', appUpdate: false, readonlySelect: true },
    { name: 'updated_at', appUpdate: true, readonlySelect: true },
  ];
  const grants = await sql<{
    name: string;
    appUpdate: boolean;
    readonlySelect: boolean;
  }>`
    SELECT a.attname AS name,
           has_column_privilege('couli_app', a.attrelid, a.attnum, 'UPDATE') AS "appUpdate",
           has_column_privilege('couli_readonly', a.attrelid, a.attnum, 'SELECT') AS "readonlySelect"
    FROM pg_attribute a
    WHERE a.attrelid = 'app.admin_users'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname = ANY(${baseline.map((c) => c.name)}::text[])
  `.execute(app);
  expect(grants.rows).toHaveLength(baseline.length);
  expect(grants.rows).toEqual(expect.arrayContaining(baseline));

  const tableGrants = await sql<{ delete: boolean; truncate: boolean }>`
    SELECT has_table_privilege('couli_app', 'app.admin_users', 'DELETE') AS delete,
           has_table_privilege('couli_app', 'app.admin_users', 'TRUNCATE') AS truncate
  `.execute(app);
  expect(tableGrants.rows).toEqual([{ delete: false, truncate: false }]);
});
