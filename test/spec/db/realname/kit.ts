// B1-13b fixtures only; raw SQL deliberately does not depend on generated table types.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

// The part of @couli/db/testing's TestDatabase this kit uses, declared locally: only *.int.test.ts
// files may import @couli/db/testing (dependency rule testcontainers-only-in-int-tests).
interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export { sqlState } from '../identity-sessions/kit.ts';

export type Table = 'realname' | 'deleted_identities';
export type Row = Record<string, unknown>;
export type Harness = {
  database: TestDatabase;
  app: Kysely<DB>;
  readonly: Kysely<DB>;
};

export const AT = new Date('2026-10-17T00:00:00.000Z');
export const LATER = new Date('2026-10-18T00:00:00.000Z');
export const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const OTHER_HASH = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
export const PRIVATE_COLUMNS = ['name_cipher', 'id_no_cipher', 'id_no_hmac', 'birth_date_cipher'];
export const UPDATE_COLUMNS = [
  ...PRIVATE_COLUMNS,
  'status',
  'provider',
  'verified_at',
  'row_version',
  'updated_at',
];
export const READ_COLUMNS = [
  'id',
  'app_id',
  'user_id',
  'status',
  'provider',
  'verified_at',
  'row_version',
  'created_at',
  'updated_at',
];

export function open(database: TestDatabase): Harness {
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

// Called in each test, before fixtures or table queries: absent migration -> AssertionError.
export async function ready(db: Kysely<DB>, table: Table): Promise<void> {
  const result = await sql<{ kind: string; partition: boolean }>`
    SELECT c.relkind::text AS kind, c.relispartition AS partition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
  `.execute(db);
  expect(result.rows, `app.${table} must exist`).toEqual([{ kind: 'r', partition: false }]);
}

export function insert(db: Kysely<DB>, table: Table | 'users', row: Row) {
  const names = Object.keys(row);
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

export function update(db: Kysely<DB>, id: unknown, values: Row) {
  return sql`UPDATE app.realname SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}

export async function person(db: Kysely<DB>, appId = `realname_${randomUUID()}`) {
  const id = randomUUID();
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

export function verified(): Row {
  return {
    status: 'verified',
    name_cipher: Buffer.from('fixture-encrypted-name'),
    id_no_cipher: Buffer.from('fixture-encrypted-id'),
    id_no_hmac: HASH,
    birth_date_cipher: Buffer.from('fixture-encrypted-birth-date'),
    provider: 'fixture-provider',
    verified_at: AT,
  };
}

export function cleared(): Row {
  return {
    status: 'none',
    name_cipher: null,
    id_no_cipher: null,
    id_no_hmac: null,
    birth_date_cipher: null,
  };
}

export async function realname(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  return { id: randomUUID(), ...(await person(db)), ...verified(), ...values };
}

export function tombstone(values: Row = {}): Row {
  return {
    app_id: `deleted_${randomUUID()}`,
    reason: 'account_deleted',
    phone_hmac: HASH,
    device_hash: null,
    deleted_at: AT,
    expire_at: LATER,
    ...values,
  };
}

export async function columns(db: Kysely<DB>, table: Table) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: boolean;
      default: string | null;
      identity: string | null;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS default, identity_generation AS identity
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = ${table}
    ORDER BY column_name`.execute(db)
  ).rows;
}
