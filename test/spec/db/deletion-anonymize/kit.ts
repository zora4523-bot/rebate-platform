// B1-15r §9.2: SQL fixtures only, independent of not-yet-generated database types.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Table = 'payout_accounts' | 'realname';
export type Row = Record<string, unknown>;
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: TestDatabase;
  app: Kysely<DB>;
}

export const AT = new Date('2026-10-23T01:02:03.456Z');
export const HASH = '0123456789abcdef'.repeat(4);
export const PAYOUT_PRIVATE = [
  'alipay_logon_id_cipher',
  'alipay_hmac',
  'bank_card_no_cipher',
  'bank_card_hmac',
  'card_bin',
] as const;
export const REALNAME_PRIVATE = [
  'name_cipher',
  'id_no_cipher',
  'id_no_hmac',
  'birth_date_cipher',
] as const;

export function open(database: TestDatabase): Harness {
  return { database, app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }) };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await destroyDb(h.app);
  await h.database.drop();
}

export async function columns(db: Kysely<DB>, table: Table) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default: string | null }>`
      SELECT column_name AS name, udt_name AS type,
        is_nullable = 'YES' AS nullable, column_default AS default
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table}
      ORDER BY column_name`.execute(db)
  ).rows;
}

// Every case first asserts its new column contract. Before the migration, failures must be
// AssertionError, not undefined_column; after it, each case exercises real database behavior.
export async function ready(db: Kysely<DB>, table: Table): Promise<void> {
  const expected =
    table === 'payout_accounts'
      ? { name: 'anonymized_at', type: 'timestamptz', nullable: true, default: null }
      : { name: 'tax_retained', type: 'bool', nullable: false, default: 'false' };
  expect(await columns(db, table), `B1-15r: app.${table}`).toContainEqual(expected);
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

export function insert(db: Kysely<DB>, table: Table | 'users', row: Row) {
  const names = Object.keys(row);
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
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

export async function person(db: Kysely<DB>, appId = `anonymize_${randomUUID()}`) {
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

export function payoutDetails(method: 'alipay' | 'bank_card'): Row {
  return {
    payout_method: method,
    alipay_logon_id_cipher: method === 'alipay' ? Buffer.from('synthetic-alipay') : null,
    alipay_hmac: method === 'alipay' ? HASH : null,
    bank_card_no_cipher: method === 'bank_card' ? Buffer.from('synthetic-bank-card') : null,
    bank_card_hmac: method === 'bank_card' ? HASH : null,
    bank_name: method === 'bank_card' ? 'fixture-bank' : null,
    card_bin: method === 'bank_card' ? '622588' : null,
    payee_name: '测试姓名',
    is_current: true,
  };
}

export function anonymized(): Row {
  return {
    anonymized_at: AT,
    is_current: false,
    payee_name: '已注销',
    bank_name: null,
    ...Object.fromEntries(PAYOUT_PRIVATE.map((name) => [name, null])),
  };
}

export async function payout(db: Kysely<DB>, method: 'alipay' | 'bank_card', values: Row = {}) {
  return { id: randomUUID(), ...(await person(db)), ...payoutDetails(method), ...values };
}

export function verified(): Row {
  return {
    name_cipher: Buffer.from('synthetic-name'),
    id_no_cipher: Buffer.from('synthetic-id'),
    id_no_hmac: HASH,
    birth_date_cipher: Buffer.from('synthetic-birth-date'),
    status: 'verified',
    provider: 'fixture-provider',
    verified_at: AT,
  };
}

export function cleared(): Row {
  return {
    status: 'none',
    provider: null,
    verified_at: null,
    ...Object.fromEntries(REALNAME_PRIVATE.map((name) => [name, null])),
  };
}

export async function realname(db: Kysely<DB>, values: Row = {}) {
  return { id: randomUUID(), ...(await person(db)), ...verified(), ...values };
}

export async function updatePrivileges(db: Kysely<DB>, table: Table, allowed: string[]) {
  const grants = await sql<{ name: string; allowed: boolean }>`
    SELECT a.attname AS name,
      has_column_privilege('couli_app', a.attrelid, a.attnum, 'UPDATE') AS allowed
    FROM pg_attribute a WHERE a.attrelid = ${`app.${table}`}::regclass
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname`.execute(db);
  expect(grants.rows.filter((r) => r.allowed).map((r) => r.name)).toEqual([...allowed].sort());
  for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
      'couli_app', ${`app.${table}`}, ${privilege}) AS allowed`.execute(db);
    expect(result.rows, `${table}/${privilege}`).toEqual([{ allowed: false }]);
  }
}

export async function immutable(db: Kysely<DB>, table: Table, row: Row, names: string[]) {
  for (const name of names) {
    expect(await sqlState(update(db, table, row['id'], { [name]: row[name] })), name).toBe('42501');
  }
  expect(
    await sqlState(
      sql`DELETE FROM ${sql.table(`app.${table}`)}
    WHERE id = ${row['id']}`.execute(db),
    ),
  ).toBe('42501');
  expect(await read(db, table, row['id'])).toEqual(row);
}
