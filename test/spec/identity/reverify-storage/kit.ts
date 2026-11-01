// B1-02zo rule-test kit (BR-WDR-01 细则「旧手机号被二次放号时的提现加验」, storage only).
// Raw SQL against the migrated template as business roles; no dependency on generated column
// types and no migration number. Every test runs a preflight assertion on the catalog before it
// touches a new column or table, so the baseline red is an assertion failure, never PostgreSQL's
// undefined_column / undefined_table error.
// Nothing here imports @couli/db/testing (depcruise testcontainers-only-in-int-tests): each
// *.int.test.ts calls createTestDatabase() itself and hands the handle to open().
import { randomBytes, randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

/** The business roles these tests connect as. */
export type TestDbRole = 'couli_app' | 'couli_payout' | 'couli_readonly' | 'couli_maint';
/** The part of @couli/db/testing's TestDatabase this kit uses, declared locally. */
export interface TestDatabase {
  urlFor(role: TestDbRole): string;
  drop(): Promise<void>;
}

export type Row = Record<string, unknown>;
export interface Harness {
  database: TestDatabase;
  dbs: Record<TestDbRole, Kysely<DB>>;
  app: Kysely<DB>;
}
export interface Owner {
  app_id: string;
  user_id: string;
}
export interface ColumnShape {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export const ROLES: readonly TestDbRole[] = [
  'couli_app',
  'couli_payout',
  'couli_readonly',
  'couli_maint',
];

// 编排 §9.2 #1: the six users columns, ordered by name.
export const USER_COLUMNS: readonly ColumnShape[] = [
  { name: 'last_active_at', type: 'timestamptz', nullable: true, default: null },
  { name: 'last_login_device_hash', type: 'text', nullable: true, default: null },
  { name: 'reverify_fail_count', type: 'int4', nullable: false, default: '0' },
  { name: 'reverify_fail_day', type: 'date', nullable: true, default: null },
  { name: 'reverify_flagged_at', type: 'timestamptz', nullable: true, default: null },
  { name: 'reverify_trusted', type: 'jsonb', nullable: true, default: null },
];
export const USER_COLUMN_NAMES = USER_COLUMNS.map((column) => column.name);

// 编排 §9.2 #1: reverified_devices has exactly these columns, ordered by name. created_at's
// default is not pinned here (fixtures omit it, so it must have one).
export const DEVICE_COLUMNS: readonly Omit<ColumnShape, 'default'>[] = [
  { name: 'app_id', type: 'text', nullable: false },
  { name: 'created_at', type: 'timestamptz', nullable: false },
  { name: 'device_hash', type: 'text', nullable: false },
  { name: 'id', type: 'uuid', nullable: false },
  { name: 'source', type: 'text', nullable: false },
  { name: 'user_id', type: 'uuid', nullable: false },
];
export const DEVICE_COLUMN_NAMES = DEVICE_COLUMNS.map((column) => column.name);

export const CHECK_VIOLATION = '23514';
export const NOT_NULL_VIOLATION = '23502';
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const PERMISSION_DENIED = '42501';
export const NO_ERROR = 'no error';

/** Wraps the test database the *.int.test.ts created (createTestDatabase). */
export function open(database: TestDatabase): Harness {
  const dbs = {} as Record<TestDbRole, Kysely<DB>>;
  for (const role of ROLES) {
    dbs[role] = createDb({ connectionString: database.urlFor(role), max: 2 });
  }
  return { database, dbs, app: dbs.couli_app };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (h === undefined) return;
  try {
    for (const role of ROLES) await destroyDb(h.dbs[role]);
  } finally {
    await h.database.drop();
  }
}

export function hash(): string {
  return randomBytes(32).toString('hex');
}

export function appId(): string {
  return `reverify_${randomUUID().replaceAll('-', '')}`;
}

async function columnsOf(db: Kysely<DB>, table: string, names: readonly string[]) {
  return (
    await sql<ColumnShape>`SELECT column_name AS name, udt_name AS type,
        is_nullable = 'YES' AS nullable, column_default AS default
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table}
        AND column_name = ANY(${[...names]}::text[])
      ORDER BY column_name`.execute(db)
  ).rows;
}

/** Preflight: the six users columns exist with the specified type, nullability and default. */
export async function expectUserColumns(db: Kysely<DB>): Promise<void> {
  expect(await columnsOf(db, 'users', USER_COLUMN_NAMES), 'app.users reverify columns').toEqual(
    USER_COLUMNS,
  );
}

/** Preflight: app.reverified_devices exists with exactly the specified columns. */
export async function expectDeviceTable(db: Kysely<DB>): Promise<void> {
  const exists = await sql<{ name: string | null }>`
    SELECT to_regclass('app.reverified_devices')::text AS name`.execute(db);
  expect(exists.rows, 'app.reverified_devices exists').toEqual([
    { name: 'app.reverified_devices' },
  ]);
  const all = (
    await sql<{ name: string; type: string; nullable: boolean }>`
      SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'reverified_devices'
      ORDER BY column_name`.execute(db)
  ).rows;
  expect(all, 'app.reverified_devices columns').toEqual(DEVICE_COLUMNS);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return NO_ERROR;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

/** A user row written only with pre-existing columns (the reverify columns are omitted). */
export async function person(db: Kysely<DB>, app = appId()): Promise<Owner> {
  const id = randomUUID();
  await sql`INSERT INTO app.users
      (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method)
    VALUES (${id}, ${app}, 'fixture', 'fixture', ${randomUUID()}, ${randomUUID()}, 'L1',
      'phone')`.execute(db);
  return { app_id: app, user_id: id };
}

/** The six reverify columns of one user; the date column is read as text (no timezone parsing). */
export async function reverifyState(db: Kysely<DB>, userId: string): Promise<Row> {
  const result = await sql<Row>`SELECT last_active_at, last_login_device_hash,
      reverify_flagged_at, reverify_trusted, reverify_fail_count,
      reverify_fail_day::text AS reverify_fail_day
    FROM app.users WHERE id = ${userId}`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export function insertDevice(
  db: Kysely<DB>,
  owner: Owner,
  deviceHash: string,
  source: string | null,
  id: string = randomUUID(),
) {
  return sql<Row>`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
    VALUES (${id}, ${owner.app_id}, ${owner.user_id}, ${deviceHash}, ${source})
    RETURNING id, app_id, user_id, device_hash, source, created_at`.execute(db);
}

export async function devicesOf(db: Kysely<DB>, owner: Owner) {
  return (
    await sql<{ device_hash: string; source: string }>`SELECT device_hash, source
      FROM app.reverified_devices
      WHERE app_id = ${owner.app_id} AND user_id = ${owner.user_id}
      ORDER BY device_hash, source`.execute(db)
  ).rows;
}
