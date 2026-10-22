// B1-15o §9.2: SQL fixtures only; no dependency on not-yet-generated column types.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Table = 'login_logs' | 'agent_sessions' | 'deletion_requests';
export type Row = Record<string, unknown>;
export interface DatabaseHandle {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: DatabaseHandle;
  app: Kysely<DB>;
  readonly: Kysely<DB>;
}

export const AT = new Date('2026-10-01T00:00:00.000Z');
export const DEADLINE = new Date('2026-10-08T00:00:00.000Z');
export const CLEANED = new Date('2026-10-08T00:00:01.123Z');
export const HASH = '0123456789abcdef'.repeat(4);

export function open(database: DatabaseHandle): Harness {
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await destroyDb(h.app);
  await destroyDb(h.readonly);
  await h.database.drop();
}

export async function columns(db: Kysely<DB>, table: Table) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: boolean;
      default: string | null;
    }>`SELECT column_name AS name, udt_name AS type,
        is_nullable = 'YES' AS nullable, column_default AS default
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table}
      ORDER BY column_name`.execute(db)
  ).rows;
}

// Preflight the relevant extension in each test. An unapplied migration must fail
// an assertion, never undefined_column or a fixture error (the red-check contract).
export async function ready(db: Kysely<DB>, table: Table): Promise<void> {
  const expected = {
    login_logs: [{ name: 'user_id', type: 'uuid', nullable: true, default: null }],
    agent_sessions: [{ name: 'user_hash', type: 'text', nullable: true, default: null }],
    deletion_requests: [
      { name: 'cleaned_at', type: 'timestamptz', nullable: true, default: null },
      { name: 'apple_revoke_attempts', type: 'int2', nullable: false, default: '0' },
      { name: 'apple_revoke_result', type: 'text', nullable: true, default: null },
    ],
  };
  expect(await columns(db, table), `${table}: B1-15o column contract`).toEqual(
    expect.arrayContaining(expected[table]),
  );
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

export async function insert(db: Kysely<DB>, table: Table | 'users' | 'devices', row: Row) {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export function update(db: Kysely<DB>, table: Table, id: unknown, values: Row) {
  return sql<Row>`UPDATE ${sql.table(`app.${table}`)} SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id} RETURNING *`.execute(db);
}

export async function read(db: Kysely<DB>, table: Table, id: unknown) {
  const result = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)}
    WHERE id = ${id}`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function person(db: Kysely<DB>) {
  const id = randomUUID();
  const appId = `cleanup_${randomUUID()}`;
  await insert(db, 'users', {
    id,
    app_id: appId,
    nickname: 'fixture',
    avatar: 'fixture',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'phone',
  });
  return { app_id: appId, user_id: id };
}

export async function fixture(db: Kysely<DB>, table: Table): Promise<Row> {
  const owner = await person(db);
  if (table === 'login_logs') {
    return {
      ...owner,
      device_id_hash: 'synthetic-device',
      device_hash: HASH,
      ip: '192.0.2.1',
      method: 'phone',
      created_at: AT,
    };
  }
  if (table === 'agent_sessions') {
    const deviceId = randomUUID();
    await insert(db, 'devices', {
      id: deviceId,
      ...owner,
      device_hash: HASH,
      id_source: 'idfv',
      platform: 'ios',
      app_version: '1.0.0',
      install_secret_cipher: Buffer.from('synthetic-install-secret'),
      last_seen_at: AT,
    });
    return {
      id: randomUUID(),
      ...owner,
      device_id: deviceId,
      started_at: AT,
      last_active_at: AT,
    };
  }
  return {
    id: randomUUID(),
    ...owner,
    status: 'processing',
    apply_at: AT,
    cooling_until: DEADLINE,
    balance_snapshot_fen: 0n,
  };
}

export async function userForeignKey(db: Kysely<DB>, table: Table): Promise<void> {
  const result = await sql`SELECT c.conname AS name, c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.pos) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.pos) AS target_keys,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update,
      c.convalidated AS validated
    FROM pg_constraint c
    WHERE c.conrelid = ${`app.${table}`}::regclass AND c.contype = 'f'
      AND c.confrelid = 'app.users'::regclass`.execute(db);
  expect(result.rows).toEqual([
    {
      name: `${table}_user_fkey`,
      target: 'app.users',
      keys: ['app_id', 'user_id'],
      target_keys: ['app_id', 'id'],
      on_delete: 'a',
      on_update: 'a',
      validated: true,
    },
  ]);
}
