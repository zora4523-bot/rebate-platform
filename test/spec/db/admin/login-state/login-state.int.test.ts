// F1-06o §9: BR-ID-34 storage and explicit migration rulings only.
// Login orchestration, the shared failure counter and Clock belong to the admin writer.
// Every case asserts column existence before referring to new columns in SQL.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, newAdmin, sqlState } from '../kit.ts';

const LOGIN_COLUMNS = ['password_must_change', 'failed_login_count', 'locked_until'] as const;
const LOCK_AT = '2026-10-09T16:30:00.123+08:00';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
let payout: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
});

afterAll(async () => {
  await Promise.all([app, readonly, payout, maint].filter(Boolean).map((db) => destroyDb(db)));
  if (database) await database.drop();
});

async function loginColumns() {
  const found = await columns(app, 'admin_users');
  for (const name of LOGIN_COLUMNS) {
    expect(
      found.map((c) => c.name),
      `app.admin_users.${name} exists`,
    ).toContain(name);
  }
  return found.filter((c) => LOGIN_COLUMNS.some((name) => name === c.name));
}

it('[AC-F1-06o#1] login state has the specified types, nullability and default presence', async () => {
  expect(await loginColumns()).toEqual(
    expect.arrayContaining([
      { name: 'password_must_change', type: 'bool', nullable: false, defaulted: true },
      { name: 'failed_login_count', type: 'int4', nullable: false, defaulted: true },
      { name: 'locked_until', type: 'timestamptz', nullable: true, defaulted: false },
    ]),
  );
});

it('[AC-F1-06o#2] an insert omitting all login columns gets false, zero and NULL', async () => {
  const found = await loginColumns();
  // newAdmin fills required columns without defaults. Assert defaults first so it cannot
  // synthesize false/zero and hide a missing database default in this omission test.
  for (const name of ['password_must_change', 'failed_login_count']) {
    expect(found.find((c) => c.name === name)?.defaulted, name).toBe(true);
  }
  expect(found.find((c) => c.name === 'locked_until')?.nullable).toBe(true);
  const row = await newAdmin(app);
  expect(row).toMatchObject({
    password_must_change: false,
    failed_login_count: 0,
    locked_until: null,
  });
  const stored = await sql<Record<string, unknown>>`
    SELECT password_must_change, failed_login_count, locked_until
    FROM app.admin_users WHERE id = ${row['id']}
  `.execute(app);
  expect(stored.rows).toEqual([
    { password_must_change: false, failed_login_count: 0, locked_until: null },
  ]);
});

it('[AC-F1-06o#3] negative failure counts reject INSERT and UPDATE with the named CHECK', async () => {
  await loginColumns();
  const row = await newAdmin(app);
  for (const count of [-1, -2147483648]) {
    await expect(newAdmin(app, { failed_login_count: count })).rejects.toMatchObject({
      code: '23514',
      constraint: 'admin_users_failed_login_count_check',
    });
    await expect(
      sql`UPDATE app.admin_users SET failed_login_count = ${count}
          WHERE id = ${row['id']}`.execute(app),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'admin_users_failed_login_count_check',
    });
  }
  const stored = await sql<{ failed_login_count: number }>`
    SELECT failed_login_count FROM app.admin_users WHERE id = ${row['id']}
  `.execute(app);
  expect(stored.rows).toEqual([{ failed_login_count: 0 }]);
});

it('[AC-F1-06o#4] zero and positive integer counts can be inserted, updated and reset', async () => {
  await loginColumns();
  for (const count of [0, 1, 5, 6, 2147483647]) {
    const row = await newAdmin(app, { failed_login_count: count });
    expect(row['failed_login_count']).toBe(count);
  }
  const row = await newAdmin(app);
  for (const count of [1, 5, 6, 2147483647, 0]) {
    const updated = await sql`UPDATE app.admin_users SET failed_login_count = ${count}
      WHERE id = ${row['id']}`.execute(app);
    expect(updated.numAffectedRows).toBe(1n);
    const stored = await sql<{ failed_login_count: number }>`
      SELECT failed_login_count FROM app.admin_users WHERE id = ${row['id']}
    `.execute(app);
    expect(stored.rows).toEqual([{ failed_login_count: count }]);
  }
});

it('[AC-F1-06o#5] the required password flag and failure count reject explicit NULL', async () => {
  await loginColumns();
  const row = await newAdmin(app);
  for (const name of ['password_must_change', 'failed_login_count']) {
    expect(await sqlState(newAdmin(app, { [name]: null })), `INSERT NULL ${name}`).toBe('23502');
    expect(
      await sqlState(
        sql`UPDATE app.admin_users SET ${sql.ref(name)} = NULL
            WHERE id = ${row['id']}`.execute(app),
      ),
      `UPDATE NULL ${name}`,
    ).toBe('23502');
  }
});

it('[AC-F1-06o#6] couli_app updates all three login columns and reads back their persisted values', async () => {
  await loginColumns();
  const row = await newAdmin(app);
  for (const mustChange of [true, false]) {
    const updated = await sql`
      UPDATE app.admin_users
      SET password_must_change = ${mustChange}, failed_login_count = 5,
          locked_until = ${LOCK_AT}::timestamptz
      WHERE id = ${row['id']}
    `.execute(app);
    expect(updated.numAffectedRows).toBe(1n);
    const stored = await sql<Record<string, unknown>>`
      SELECT password_must_change, failed_login_count, locked_until
      FROM app.admin_users WHERE id = ${row['id']}
    `.execute(app);
    expect(stored.rows).toEqual([
      { password_must_change: mustChange, failed_login_count: 5, locked_until: new Date(LOCK_AT) },
    ]);
  }
});

it('[AC-F1-06o#7] locked_until preserves an offset timestamp as an instant and can return to NULL', async () => {
  await loginColumns();
  const row = await newAdmin(app);
  for (const instant of [LOCK_AT, '2026-10-09T03:45:00.456-05:00', null]) {
    const updated = await sql`
      UPDATE app.admin_users SET locked_until = ${instant}::timestamptz
      WHERE id = ${row['id']}
    `.execute(app);
    expect(updated.numAffectedRows).toBe(1n);
    const stored = await sql<{ locked_until: Date | null }>`
      SELECT locked_until FROM app.admin_users WHERE id = ${row['id']}
    `.execute(app);
    expect(stored.rows).toEqual([{ locked_until: instant === null ? null : new Date(instant) }]);
  }
});

it('[AC-F1-06o#8] couli_app retains table SELECT/INSERT but receives only column-level UPDATE', async () => {
  await loginColumns();
  const grants = await sql<{ select: boolean; insert: boolean; update: boolean }>`
    SELECT has_table_privilege('couli_app', 'app.admin_users', 'SELECT') AS select,
           has_table_privilege('couli_app', 'app.admin_users', 'INSERT') AS insert,
           has_table_privilege('couli_app', 'app.admin_users', 'UPDATE') AS update
  `.execute(app);
  expect(grants.rows).toEqual([{ select: true, insert: true, update: false }]);
  for (const name of LOGIN_COLUMNS) {
    const grant = await sql<{ held: boolean }>`
      SELECT has_column_privilege('couli_app', 'app.admin_users', ${name}, 'UPDATE') AS held
    `.execute(app);
    expect(grant.rows, name).toEqual([{ held: true }]);
  }
  // Identity columns that were not writable in the baseline remain protected.
  for (const name of ['id', 'app_id', 'login_name', 'created_at']) {
    const grant = await sql<{ held: boolean }>`
      SELECT has_column_privilege('couli_app', 'app.admin_users', ${name}, 'UPDATE') AS held
    `.execute(app);
    expect(grant.rows, name).toEqual([{ held: false }]);
  }
});

it('[AC-F1-06o#9] couli_readonly cannot SELECT any login-state column', async () => {
  await loginColumns();
  for (const name of LOGIN_COLUMNS) {
    const grant = await sql<{ held: boolean }>`
      SELECT has_column_privilege('couli_readonly', 'app.admin_users', ${name}, 'SELECT') AS held
    `.execute(app);
    expect(grant.rows, name).toEqual([{ held: false }]);
    expect(
      await sqlState(
        sql`SELECT ${sql.ref(name)} FROM app.admin_users WHERE false`.execute(readonly),
      ),
      name,
    ).toBe('42501');
  }
});

it('[AC-F1-06o#10] readonly, payout and maintenance roles cannot UPDATE any login-state column', async () => {
  await loginColumns();
  for (const [role, db] of [
    ['couli_readonly', readonly],
    ['couli_payout', payout],
    ['couli_maint', maint],
  ] as const) {
    for (const [name, value] of [
      ['password_must_change', true],
      ['failed_login_count', 5],
      ['locked_until', new Date(LOCK_AT)],
    ] as const) {
      const grant = await sql<{ held: boolean }>`
        SELECT has_column_privilege(${role}, 'app.admin_users', ${name}, 'UPDATE') AS held
      `.execute(app);
      expect(grant.rows, `${role} UPDATE ${name}`).toEqual([{ held: false }]);
      // No column reads or RETURNING: missing SELECT must not conceal an UPDATE grant.
      expect(
        await sqlState(
          sql`UPDATE app.admin_users SET ${sql.ref(name)} = ${value} WHERE false`.execute(db),
        ),
        `${role} UPDATE ${name}`,
      ).toBe('42501');
    }
  }
});

it('[AC-F1-06o#11] login state adds no application triggers to admin_users', async () => {
  await loginColumns();
  const triggers = await sql<{ name: string }>`
    SELECT tgname AS name FROM pg_trigger
    WHERE tgrelid = 'app.admin_users'::regclass AND NOT tgisinternal
  `.execute(app);
  expect(triggers.rows).toEqual([]);
});
