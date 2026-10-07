// B1-02n §9.3–9.4: application Clock insertion, with the existing default and ACLs intact.
// Basis: 规划/04 §3.2 device_registrations; BR-ID-05 细则「同设备注册上限的计数」 (sliding 30×24 h);
// ADR-0001 §4.2 #10 (Clock, CLOCK_NOW on staging) and #21 (Clock timestamps instead of SQL now()).
// The one-off database comes from the integration global setup; every query here runs as couli_app.
// These local AC labels identify task assertions, not new planning acceptance criteria.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { hex64, newUser, sqlState, useDb } from '../kit.ts';

const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const DENIED = '42501';
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

// Anchor fixtures to the database clock so past/future retain their meaning on later runs.
// Transfer timestamps as text: JavaScript Date would discard the last three microseconds.
async function instant(hoursFromNow: number): Promise<string> {
  const result = await sql<{ value: string }>`
    SELECT to_char((date_trunc('second', now())
      + ${hoursFromNow} * interval '1 hour' + interval '0.123456 seconds')
      AT TIME ZONE 'UTC', ${FORMAT}) AS value
  `.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.value;
}

async function shift(value: string, microseconds: number): Promise<string> {
  const result = await sql<{ value: string }>`
    SELECT to_char((${value}::timestamptz + ${microseconds} * interval '1 microsecond')
      AT TIME ZONE 'UTC', ${FORMAT}) AS value
  `.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.value;
}

async function register(createdAt: string, deviceHash = hex64()): Promise<string> {
  const userId = await newUser();
  // Before the migration this is an assertion failure (42501), not an uncaught PG error.
  expect(
    await sqlState(
      sql`
      INSERT INTO app.device_registrations
        (app_id, device_hash, user_id, register_method, created_at)
      VALUES ('couli', ${deviceHash}, ${userId}, 'sms', ${createdAt}::timestamptz)
    `.execute(app),
    ),
    'couli_app must accept the application Clock timestamp on INSERT',
  ).toBe('no error');
  return userId;
}

async function registration(userId: string) {
  const result = await sql<{ created_at: string; merged_into_user_id: string | null }>`
    SELECT to_char(created_at AT TIME ZONE 'UTC', ${FORMAT}) AS created_at,
      merged_into_user_id
    FROM app.device_registrations WHERE app_id = 'couli' AND user_id = ${userId}
  `.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

it('[AC-B1-02n#1] accepts a timestamp 29 days in the past without losing microseconds', async () => {
  const past = await instant(-29 * 24);
  const userId = await register(past);
  expect(await registration(userId)).toEqual({ created_at: past, merged_into_user_id: null });
});

it('[AC-B1-02n#2] accepts a staging Clock 40 days ahead without clamping or losing microseconds', async () => {
  const future = await instant(40 * 24);
  const userId = await register(future);
  expect(await registration(userId)).toEqual({ created_at: future, merged_into_user_id: null });
});

it('[AC-B1-02n#3] explicit Clock writes coexist with the unchanged NOT NULL timestamptz default now()', async () => {
  const shape = await sql<{ udt_name: string; is_nullable: string; column_default: string }>`
    SELECT udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'device_registrations'
      AND column_name = 'created_at'
  `.execute(app);
  expect(shape.rows).toEqual([
    { udt_name: 'timestamptz', is_nullable: 'NO', column_default: 'now()' },
  ]);

  const userId = await newUser();
  await app.transaction().execute(async (trx) => {
    // now() is constant within this transaction; equality avoids wall-clock/scheduling flakes.
    await sql`
      INSERT INTO app.device_registrations (app_id, device_hash, user_id, register_method)
      VALUES ('couli', ${hex64()}, ${userId}, 'sms')
    `.execute(trx);
    const result = await sql<{ uses_default: boolean }>`
      SELECT created_at = now() AS uses_default FROM app.device_registrations
      WHERE app_id = 'couli' AND user_id = ${userId}
    `.execute(trx);
    expect(result.rows).toEqual([{ uses_default: true }]);
  });

  const future = await instant(40 * 24);
  const explicitUser = await register(future);
  expect((await registration(explicitUser)).created_at).toBe(future);
});

it('[AC-B1-02n#4] Clock-stamped rows remain immutable and permit only a one-time merge annotation', async () => {
  const future = await instant(40 * 24);
  const source = await register(future);
  const target = await newUser();
  const other = await newUser();
  expect(
    await sqlState(
      sql`
    UPDATE app.device_registrations SET created_at = created_at - interval '720 hours'
    WHERE app_id = 'couli' AND user_id = ${source}
  `.execute(app),
    ),
  ).toBe(DENIED);
  expect(await registration(source)).toEqual({ created_at: future, merged_into_user_id: null });

  expect(
    await sqlState(
      sql`
    UPDATE app.device_registrations SET merged_into_user_id = ${target}
    WHERE app_id = 'couli' AND user_id = ${source}
  `.execute(app),
    ),
  ).toBe('no error');
  expect(await registration(source)).toEqual({ created_at: future, merged_into_user_id: target });

  for (const replacement of [other, null]) {
    expect(
      await sqlState(
        sql`
      UPDATE app.device_registrations SET merged_into_user_id = ${replacement}
      WHERE app_id = 'couli' AND user_id = ${source}
    `.execute(app),
      ),
    ).toBe('23001');
    expect(await registration(source)).toEqual({ created_at: future, merged_into_user_id: target });
  }

  expect(
    await sqlState(
      sql`
    INSERT INTO app.device_registrations
      (app_id, device_hash, user_id, register_method, created_at, merged_into_user_id)
    VALUES ('couli', ${hex64()}, ${other}, 'sms', ${future}::timestamptz, ${target})
  `.execute(app),
    ),
  ).toBe(DENIED);
  const rejected = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.device_registrations
    WHERE app_id = 'couli' AND user_id = ${other}
  `.execute(app);
  expect(rejected.rows).toEqual([{ n: '0' }]);
});

it('[AC-B1-02n#5] grants only the additional INSERT column; all role privilege boundaries remain', async () => {
  const columns = [
    'app_id',
    'device_hash',
    'user_id',
    'register_method',
    'created_at',
    'merged_into_user_id',
  ];
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    const result = await sql<{
      name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_reference: boolean;
    }>`
      SELECT a.attname AS name,
        has_column_privilege(${role}, a.attrelid, a.attnum, 'SELECT') AS can_select,
        has_column_privilege(${role}, a.attrelid, a.attnum, 'INSERT') AS can_insert,
        has_column_privilege(${role}, a.attrelid, a.attnum, 'UPDATE') AS can_update,
        has_column_privilege(${role}, a.attrelid, a.attnum, 'REFERENCES') AS can_reference
      FROM pg_attribute a WHERE a.attrelid = 'app.device_registrations'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
    `.execute(app);
    expect(result.rows, `${role} column permissions`).toEqual(
      columns.map((name) => ({
        name,
        can_select: role === 'couli_app' || role === 'couli_readonly',
        can_insert: role === 'couli_app' && name !== 'merged_into_user_id',
        can_update: role === 'couli_app' && name === 'merged_into_user_id',
        can_reference: false,
      })),
    );
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]) {
      const table = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege(${role}, 'app.device_registrations', ${privilege}) AS allowed
      `.execute(app);
      expect(table.rows, `${role} table ${privilege}`).toEqual([
        {
          allowed: privilege === 'SELECT' && (role === 'couli_app' || role === 'couli_readonly'),
        },
      ]);
    }
  }
});

it('[AC-B1-02n#6] counts application Clock rows newer than T - 30×24h, excluding database-default old rows', async () => {
  const clock = await instant(40 * 24);
  const device = hex64();
  const atClock = await register(clock, device);
  const windowMicroseconds = 30 * 24 * 60 * 60 * 1_000_000;
  const lower = await shift(clock, -windowMicroseconds);
  const inside = await register(await shift(lower, 1), device);
  const atLower = await register(lower, device);
  const beforeLower = await register(await shift(lower, -1), device);
  const afterClock = await register(await shift(clock, 1), device);
  const otherDevice = await register(clock);
  const defaultUser = await newUser();
  await sql`
    INSERT INTO app.device_registrations (app_id, device_hash, user_id, register_method)
    VALUES ('couli', ${device}, ${defaultUser}, 'sms')
  `.execute(app);

  const result = await sql<{ user_id: string }>`
    SELECT user_id FROM app.device_registrations
    WHERE app_id = 'couli' AND device_hash = ${device}
      AND created_at > ${clock}::timestamptz - interval '720 hours'
  `.execute(app);
  const counted = result.rows.map((row) => row.user_id).sort();
  // Lower bound open, no upper bound: a record newer than the Clock still counts (B1-02i).
  expect(counted, 'the Clock-stamped registrations must count').toEqual(
    [atClock, inside, afterClock].sort(),
  );
  for (const excluded of [atLower, beforeLower, otherDevice, defaultUser]) {
    expect(counted).not.toContain(excluded);
  }
  const old = await sql<{ outside_window: boolean }>`
    SELECT created_at <= ${clock}::timestamptz - interval '720 hours' AS outside_window
    FROM app.device_registrations WHERE app_id = 'couli' AND user_id = ${defaultUser}
  `.execute(app);
  expect(
    old.rows,
    'database now() falls outside the staging Clock window: the original defect',
  ).toEqual([{ outside_window: true }]);
});
