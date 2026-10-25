// B1-27d §9: fixtures and catalog helpers only, independent of generated table types.
// Business-role connections only; the test database itself is created by each test file.
import { createHash, randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export type Row = Record<string, unknown>;
export interface Harness {
  database: TestDatabase;
  app: Kysely<DB>;
  readonly: Kysely<DB>;
}

export const COPIES = 'personal_data_copies';
export const PRIOR = 'realname_prior_identities';
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
export const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
] as const;
export const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

// contracts/enums/identity.yaml personal_data_copy_delivery / personal_data_copy_status.
export const DELIVERIES = ['in_app_sms', 'wecom_session'];
export const OPEN_STATUSES = ['pending', 'running', 'ready'];
export const CLOSED_STATUSES = ['delivered', 'failed', 'expired', 'cancelled'];
export const STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES];

// 任务书 §9 ④: the only columns couli_app may update on personal_data_copies.
export const COPY_UPDATE_COLUMNS = [
  'status',
  'object_key',
  'generated_at',
  'delivered_at',
  'expires_at',
  'failure_reason',
  'row_version',
  'updated_at',
];
export const COPY_IMMUTABLE_COLUMNS = [
  'id',
  'app_id',
  'user_id',
  'requested_by',
  'delivery',
  'retry_of',
  'due_at',
  'created_at',
];
// 任务书 §9 ⑤.
export const PRIOR_COLUMNS = [
  'app_id',
  'user_id',
  'name_cipher',
  'id_no_cipher',
  'id_no_hmac',
  'verified_at',
  'corrected_at',
  'created_at',
];

export const DUE = new Date('2026-11-21T15:59:59.000Z');
export const GENERATED = new Date('2026-11-02T09:05:00.000Z');
export const DELIVERED = new Date('2026-11-02T09:06:00.000Z');
export const EXPIRES = new Date('2026-11-03T09:05:00.000Z');
export const VERIFIED = new Date('2026-03-01T02:00:00.000Z');
export const CORRECTED = new Date('2026-11-02T10:00:00.000Z');

export function open(database: TestDatabase): Harness {
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await destroyDb(h.app);
  await destroyDb(h.readonly);
  await h.database.drop();
}

// Each test checks existence first, so a missing migration fails with an AssertionError rather
// than an undefined-table SQL error.
export async function ready(db: Kysely<DB>, table: string): Promise<void> {
  const result = await sql<{ kind: string; partition: boolean }>`
    SELECT c.relkind::text AS kind, c.relispartition AS partition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
  `.execute(db);
  expect(result.rows, `app.${table} must exist as an ordinary table`).toEqual([
    { kind: 'r', partition: false },
  ]);
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

export interface ColumnShape {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  identity: string;
  generated: string;
}

// pg_catalog rather than information_schema: visibility does not depend on column privileges.
export async function shape(db: Kysely<DB>, table: string): Promise<ColumnShape[]> {
  const result = await sql<ColumnShape>`
    SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
      pg_get_expr(d.adbin, d.adrelid) AS default,
      a.attidentity::text AS identity, a.attgenerated::text AS generated
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'app' AND c.relname = ${table} AND a.attnum > 0 AND NOT a.attisdropped
  `.execute(db);
  return result.rows.sort((a, b) => byName(a.name, b.name));
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function expectedShape(columns: [string, string, boolean, string | null][]): ColumnShape[] {
  return [...columns]
    .sort(([a], [b]) => byName(a, b))
    .map(([name, type, nullable, defaultValue]) => ({
      name,
      type,
      nullable,
      default: defaultValue,
      identity: '',
      generated: '',
    }));
}

export interface Constraint {
  kind: string;
  keys: string[];
  target: string | null;
  target_keys: string[];
  on_update: string;
  on_delete: string;
  validated: boolean;
}

export async function constraints(db: Kysely<DB>, table: string): Promise<Constraint[]> {
  const result = await sql<Constraint>`
    SELECT c.contype::text AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        ORDER BY k.position) AS keys,
      CASE WHEN c.confrelid = 0 THEN NULL ELSE tn.nspname || '.' || tc.relname END AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num
        ORDER BY k.position) AS target_keys,
      c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete,
      c.convalidated AS validated
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class r ON r.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
    WHERE n.nspname = 'app' AND r.relname = ${table} AND c.contype IN ('p', 'u', 'f')
  `.execute(db);
  return result.rows;
}

export interface IndexShape {
  keys: string[];
  unique: boolean;
  predicate: string | null;
  expression: boolean;
  valid: boolean;
}

export async function indexes(db: Kysely<DB>, table: string): Promise<IndexShape[]> {
  const result = await sql<IndexShape>`
    SELECT ARRAY(SELECT a.attname::text
        FROM unnest(i.indkey) WITH ORDINALITY k(num, position)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.position <= i.indnkeyatts ORDER BY k.position) AS keys,
      i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      (i.indexprs IS NOT NULL) AS expression, (i.indisvalid AND i.indisready) AS valid
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class r ON r.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'app' AND r.relname = ${table}
  `.execute(db);
  return result.rows;
}

export async function tableAllowed(
  db: Kysely<DB>,
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS allowed
  `.execute(db);
  return result.rows[0]!.allowed;
}

export async function columnAllowed(
  db: Kysely<DB>,
  role: string,
  table: string,
  column: string,
  privilege: string,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT has_column_privilege(${role}, ${`app.${table}`}, ${column}, ${privilege}) AS allowed
  `.execute(db);
  return result.rows[0]!.allowed;
}

export function insert(db: Kysely<DB>, table: string, row: Row) {
  const names = Object.keys(row);
  return sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

export function update(db: Kysely<DB>, id: unknown, values: Row) {
  return sql`UPDATE app.personal_data_copies SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}

export async function stored(db: Kysely<DB>, id: unknown): Promise<Row[]> {
  const result = await sql<Row>`SELECT * FROM app.personal_data_copies WHERE id = ${id}`.execute(
    db,
  );
  return result.rows;
}

export async function person(db: Kysely<DB>, appId = `copies_${randomUUID()}`) {
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

export async function admin(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'admin_users', {
    id,
    app_id: appId,
    login_name: `fixture_${randomUUID()}`,
    password_hash: 'fixture-password-hash',
    is_super: false,
    status: 'active',
  });
  return id;
}

// A pending request of a fresh user, registered by a fresh admin of the same app.
export async function copy(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  const owner = await person(db);
  return {
    id: randomUUID(),
    ...owner,
    requested_by: await admin(db, owner.app_id),
    delivery: 'in_app_sms',
    status: 'pending',
    retry_of: null,
    object_key: null,
    due_at: DUE,
    generated_at: null,
    delivered_at: null,
    expires_at: null,
    failure_reason: null,
    ...values,
  };
}

// Another request of the same user and registrant.
export function sibling(row: Row, values: Row = {}): Row {
  return { ...row, id: randomUUID(), ...values };
}

export async function prior(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  return {
    ...(await person(db)),
    name_cipher: Buffer.from('fixture-name-ciphertext'),
    id_no_cipher: Buffer.from('fixture-id-number-ciphertext'),
    id_no_hmac: createHash('sha256').update(randomUUID()).digest('hex'),
    verified_at: VERIFIED,
    corrected_at: CORRECTED,
    ...values,
  };
}
