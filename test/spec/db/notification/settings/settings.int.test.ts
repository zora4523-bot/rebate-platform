// B1-12l task supplement B: storage shape and grants for notification's settings.
// The reader's all-true fallback belongs to B1-12m; this migration must not seed rows.
// Check table existence first so the missing migration fails assertions in every red case.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { foreignKeys, hasPrivilege, newUser, sqlState, useDb } from '../kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

const SWITCHES = ['service_push', 'subscription_push', 'marketing_push'] as const;
const CREATED = new Date('2026-10-20T08:00:00Z');
const UPDATED = new Date('2026-10-21T09:00:00Z');

async function requireTable(): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'app' AND t.relname = 'notification_settings'
        AND t.relkind IN ('r', 'p')
    ) AS present
  `.execute(app);
  expect(result.rows, 'app.notification_settings exists before exercising its constraints').toEqual(
    [{ present: true }],
  );
}

async function columns() {
  const result = await sql<{
    name: string;
    type: string;
    nullable: boolean;
    default_value: string | null;
  }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS default_value
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'notification_settings'
    ORDER BY column_name
  `.execute(app);
  return result.rows;
}

function settings(userId: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_id: 'couli',
    user_id: userId,
    service_push: true,
    subscription_push: true,
    marketing_push: true,
    ...values,
  };
}

// Do not fill settings from catalog metadata: missing required columns/defaults must fail.
async function insert(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const names = Object.keys(row);
  const result = await sql<Record<string, unknown>>`
    INSERT INTO app.notification_settings (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

it('[AC-B1-12l#1] settings have exactly the agreed non-null columns and types', async () => {
  await requireTable();
  expect((await columns()).map(({ name, type, nullable }) => [name, type, nullable])).toEqual([
    ['app_id', 'text', false],
    ['created_at', 'timestamptz', false],
    ['marketing_push', 'bool', false],
    ['row_version', 'int4', false],
    ['service_push', 'bool', false],
    ['subscription_push', 'bool', false],
    ['updated_at', 'timestamptz', false],
    ['user_id', 'uuid', false],
  ]);
});

it('[AC-B1-12l#2] switches have no defaults and a newly created user has no settings row', async () => {
  await requireTable();
  const metadata = await columns();
  for (const name of [...SWITCHES, 'app_id', 'user_id']) {
    expect(metadata.find((column) => column.name === name)?.default_value, name).toBeNull();
  }
  const user = await newUser();
  const result = await sql`SELECT * FROM app.notification_settings
    WHERE app_id = 'couli' AND user_id = ${user}`.execute(app);
  expect(result.rows).toEqual([]);
  for (const name of SWITCHES) {
    const row = settings(user);
    delete row[name];
    expect(await sqlState(insert(row)), `omitted ${name}`).toBe('23502');
  }
});

it('[AC-B1-12l#3] all eight independent switch combinations persist as booleans', async () => {
  await requireTable();
  for (const service_push of [true, false]) {
    for (const subscription_push of [true, false]) {
      for (const marketing_push of [true, false]) {
        const row = settings(await newUser(), { service_push, subscription_push, marketing_push });
        expect(await insert(row)).toMatchObject(row);
      }
    }
  }
});

it('[AC-B1-12l#4] every required column rejects explicit NULL; switches also reject NULL updates', async () => {
  await requireTable();
  const user = await newUser();
  for (const name of [
    'app_id',
    'user_id',
    ...SWITCHES,
    'row_version',
    'created_at',
    'updated_at',
  ]) {
    expect(await sqlState(insert(settings(user, { [name]: null }))), name).toBe('23502');
  }
  await insert(settings(user));
  for (const name of SWITCHES) {
    expect(
      await sqlState(
        sql`UPDATE app.notification_settings SET ${sql.ref(name)} = NULL
        WHERE app_id = 'couli' AND user_id = ${user}`.execute(app),
      ),
      name,
    ).toBe('23502');
  }
});

it('[AC-B1-12l#5] version defaults to zero and audit timestamps default to transaction time', async () => {
  await requireTable();
  const metadata = await columns();
  expect(metadata.find((column) => column.name === 'row_version')?.default_value).toBe('0');
  for (const name of ['created_at', 'updated_at']) {
    expect(metadata.find((column) => column.name === name)?.default_value, name).toMatch(
      /^(now\(\)|CURRENT_TIMESTAMP)$/i,
    );
  }
  const user = await newUser();
  await app.transaction().execute(async (tx) => {
    const result = await sql<{ version: number; created: boolean; updated: boolean }>`
      INSERT INTO app.notification_settings
        (app_id, user_id, service_push, subscription_push, marketing_push)
      VALUES ('couli', ${user}, true, false, true)
      RETURNING row_version AS version, created_at = now() AS created, updated_at = now() AS updated
    `.execute(tx);
    expect(result.rows).toEqual([{ version: 0, created: true, updated: true }]);
  });
  const explicit = settings(await newUser(), { created_at: CREATED, updated_at: UPDATED });
  expect(await insert(explicit)).toMatchObject(explicit);
});

it('[AC-B1-12l#6] primary key is (app_id, user_id); duplicate settings fail but other users and apps work', async () => {
  await requireTable();
  const key = await sql<{ name: string }>`
    SELECT a.attname AS name FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'app' AND t.relname = 'notification_settings' AND c.contype = 'p'
    ORDER BY k.ord
  `.execute(app);
  expect(key.rows.map((row) => row.name)).toEqual(['app_id', 'user_id']);
  const user = await newUser();
  await insert(settings(user));
  expect(await sqlState(insert(settings(user, { service_push: false })))).toBe('23505');
  expect(await insert(settings(await newUser()))).toMatchObject({ app_id: 'couli' });
  const other = await newUser('couli_two');
  expect(await insert(settings(other, { app_id: 'couli_two' }))).toMatchObject({
    app_id: 'couli_two',
    user_id: other,
  });
});

it('[AC-B1-12l#7] concurrent inserts for the same account persist exactly one row', async () => {
  await requireTable();
  const user = await newUser();
  const outcomes = await Promise.all([
    sqlState(insert(settings(user))),
    sqlState(insert(settings(user, { marketing_push: false }))),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const result = await sql<{ count: number }>`SELECT count(*)::integer AS count
    FROM app.notification_settings WHERE app_id = 'couli' AND user_id = ${user}`.execute(app);
  expect(result.rows).toEqual([{ count: 1 }]);
});

it('[AC-B1-12l#8] users foreign key includes app_id, rejects missing/cross-app users and forbids cascading', async () => {
  await requireTable();
  const keys = await foreignKeys('notification_settings');
  expect(keys).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        columns: ['app_id', 'user_id'],
        target: 'users',
        targetColumns: ['app_id', 'id'],
      }),
    ]),
  );
  for (const key of keys) {
    expect(['a', 'r'], `${key.name} ON DELETE`).toContain(key.onDelete);
    expect(['a', 'r'], `${key.name} ON UPDATE`).toContain(key.onUpdate);
  }
  const user = await newUser();
  expect(await sqlState(insert(settings(randomUUID())))).toBe('23503');
  expect(await sqlState(insert(settings(user, { app_id: 'couli_two' })))).toBe('23503');
  expect(await insert(settings(user))).toMatchObject({ user_id: user });
});

it('[AC-B1-12l#9] app has SELECT/INSERT and UPDATE only on switches, version and updated_at', async () => {
  await requireTable();
  for (const privilege of ['SELECT', 'INSERT']) {
    expect(await hasPrivilege('couli_app', 'notification_settings', privilege), privilege).toBe(
      true,
    );
  }
  expect(await hasPrivilege('couli_app', 'notification_settings', 'UPDATE')).toBe(false);
  for (const name of (await columns()).map((column) => column.name)) {
    const result = await sql<{ allowed: boolean }>`
      SELECT has_column_privilege('couli_app', 'app.notification_settings', ${name}, 'UPDATE')
        AS allowed
    `.execute(app);
    expect(result.rows, name).toEqual([
      { allowed: [...SWITCHES, 'row_version', 'updated_at'].includes(name) },
    ]);
  }
});

it('[AC-B1-12l#10] app can change each switch and perform versioned updates without changing other accounts', async () => {
  await requireTable();
  const user = await newUser();
  await insert(settings(user, { created_at: CREATED, updated_at: CREATED }));
  const other = await newUser();
  const otherRow = await insert(settings(other));
  for (const name of SWITCHES) {
    for (const value of [false, true]) {
      const changed = await sql`UPDATE app.notification_settings SET ${sql.ref(name)} = ${value}
        WHERE app_id = 'couli' AND user_id = ${user} RETURNING ${sql.ref(name)}`.execute(app);
      expect(changed.rows).toEqual([{ [name]: value }]);
    }
  }
  const changed = await sql`UPDATE app.notification_settings
    SET service_push = false, subscription_push = false, marketing_push = false,
      row_version = row_version + 1, updated_at = ${UPDATED}
    WHERE app_id = 'couli' AND user_id = ${user} AND row_version = 0
    RETURNING *`.execute(app);
  expect(changed.rows).toEqual([
    settings(user, {
      service_push: false,
      subscription_push: false,
      marketing_push: false,
      row_version: 1,
      created_at: CREATED,
      updated_at: UPDATED,
    }),
  ]);
  const stale = await sql`UPDATE app.notification_settings
    SET service_push = true, row_version = row_version + 1
    WHERE app_id = 'couli' AND user_id = ${user} AND row_version = 0`.execute(app);
  expect(stale.numAffectedRows).toBe(0n);
  const untouched = await sql`SELECT * FROM app.notification_settings
    WHERE app_id = 'couli' AND user_id = ${other}`.execute(app);
  expect(untouched.rows).toEqual([otherRow]);
});

it('[AC-B1-12l#11] app cannot update identity/creation columns or delete/truncate settings', async () => {
  await requireTable();
  const user = await newUser();
  const original = await insert(settings(user));
  for (const name of ['app_id', 'user_id', 'created_at']) {
    expect(
      await sqlState(
        sql`UPDATE app.notification_settings SET ${sql.ref(name)} = ${sql.ref(name)}
        WHERE app_id = 'couli' AND user_id = ${user}`.execute(app),
      ),
      name,
    ).toBe('42501');
  }
  for (const privilege of ['DELETE', 'TRUNCATE']) {
    expect(await hasPrivilege('couli_app', 'notification_settings', privilege), privilege).toBe(
      false,
    );
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.notification_settings
      WHERE app_id = 'couli' AND user_id = ${user}`.execute(app),
    ),
  ).toBe('42501');
  const stored = await sql`SELECT * FROM app.notification_settings
    WHERE app_id = 'couli' AND user_id = ${user}`.execute(app);
  expect(stored.rows).toEqual([original]);
});
