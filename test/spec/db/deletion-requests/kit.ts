// B1-15a §9.2–9.3: fixtures and SQL helpers only, independent of generated table types.
import { randomUUID } from 'node:crypto';

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

export const APPLY = new Date('2026-09-29T10:00:00.000Z');
export const DEADLINE = new Date('2026-10-06T10:00:00.000Z');
export const BEFORE = new Date('2026-10-06T09:59:59.000Z');
export const AFTER = new Date('2026-10-06T10:00:01.000Z');
export const UPDATE_COLUMNS = [
  'status',
  'cancelled_at',
  'cancel_reason',
  'processed_at',
  'row_version',
  'updated_at',
];
export const IMMUTABLE_COLUMNS = [
  'id',
  'app_id',
  'user_id',
  'apply_at',
  'cooling_until',
  'balance_snapshot_fen',
  'created_at',
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

// Each test checks existence before any fixtures or table operations, so a missing
// migration fails with AssertionError, not an undefined-table SQL error.
export async function ready(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ kind: string; partition: boolean }>`
    SELECT c.relkind::text AS kind, c.relispartition AS partition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'deletion_requests'
  `.execute(db);
  expect(result.rows, 'app.deletion_requests must exist').toEqual([
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

export function insert(
  db: Kysely<DB>,
  row: Row,
  table: 'users' | 'deletion_requests' = 'deletion_requests',
) {
  const names = Object.keys(row);
  return sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

export function update(db: Kysely<DB>, id: unknown, values: Row) {
  return sql`UPDATE app.deletion_requests SET
    ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id}`.execute(db);
}

export async function person(db: Kysely<DB>, appId = `deletion_${randomUUID()}`) {
  const id = randomUUID();
  await insert(
    db,
    {
      id,
      app_id: appId,
      nickname: 'fixture',
      avatar: 'fixture',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      register_method: 'phone',
    },
    'users',
  );
  return { app_id: appId, user_id: id };
}

export async function request(db: Kysely<DB>, values: Row = {}): Promise<Row> {
  return {
    id: randomUUID(),
    ...(await person(db)),
    status: 'cooling',
    apply_at: APPLY,
    cooling_until: DEADLINE,
    cancelled_at: null,
    cancel_reason: null,
    processed_at: null,
    balance_snapshot_fen: 0n,
    ...values,
  };
}

export function state(status: string): Row {
  return {
    status,
    cancelled_at: status === 'cancelled' ? BEFORE : null,
    cancel_reason: status === 'cancelled' ? 'user' : null,
    processed_at: status === 'done' ? DEADLINE : null,
  };
}
