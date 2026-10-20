// CT-25d §9.2–9.3: independent storage expectations, without CT-25b's fixture/shape.
// TEST_PG_ADMIN_URL is read only by the integration globalSetup. The int test passes
// createTestDatabase in; all queries here use business roles, never the admin URL.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
export const QUALIFIED_AT = new Date('2026-10-20T00:00:00.000Z');
export const STATUSES = ['qualified', 'deferred', 'processed', 'voided', 'expired'] as const;
export const UPDATABLE = [
  'trigger_order_id',
  'triggered_at',
  'status',
  'inviter_result',
  'invitee_result',
  'inviter_skip_reason',
  'invitee_skip_reason',
  'void_reason',
  'inviter_voucher_id',
  'invitee_voucher_id',
  'granted_at',
  'row_version',
] as const;

interface TestDatabaseLike {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: TestDatabaseLike;
  app: Connection;
  readonly: Connection;
}
export async function open(create: () => Promise<TestDatabaseLike>): Promise<Harness> {
  const database = await create();
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.app), destroyDb(h.readonly)]);
  await h.database.drop();
}
export async function eligibilityColumn(db: Connection) {
  return sql<{
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>`SELECT udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'invite_rewards'
      AND column_name = 'eligibility_days'`.execute(db);
}
export async function ready(db: Connection): Promise<void> {
  // A missing migration must fail an assertion inside each test, not raise undefined_column
  // from a fixture or fail a shared hook. No catalog-driven skipping or alternate expectations.
  expect((await eligibilityColumn(db)).rows, 'CT-25d must add the locked days column').toEqual([
    { udt_name: 'int4', is_nullable: 'NO', column_default: null },
  ]);
}
export async function insert(db: Connection, table: 'users' | 'invite_rewards', row: Row) {
  return sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((column) => sql.ref(column)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
}
export async function reward(db: Connection): Promise<Row> {
  const app = `ct25d_${randomUUID().replaceAll('-', '')}`;
  const invitee = randomUUID();
  const inviter = randomUUID();
  for (const id of [invitee, inviter]) {
    await insert(db, 'users', {
      id,
      app_id: app,
      nickname: 'synthetic',
      avatar: '',
      invite_code: id,
      attr_code: id,
      level: 'L1',
      register_method: 'phone',
    });
  }
  return {
    app_id: app,
    invitee_id: invitee,
    inviter_id: inviter,
    amount_fen: 100n,
    eligibility_days: 30,
    qualified_at: QUALIFIED_AT,
    bind_source: 'register',
    bind_ip_hmac: 'a'.repeat(64),
    status: 'qualified',
  };
}
export async function read(db: Connection, row: Row) {
  return sql<Row>`SELECT * FROM app.invite_rewards
    WHERE app_id = ${row['app_id']} AND invitee_id = ${row['invitee_id']}`.execute(db);
}
export async function update(db: Connection, row: Row, changes: Row) {
  return sql<Row>`UPDATE app.invite_rewards SET
    ${sql.join(Object.entries(changes).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE app_id = ${row['app_id']} AND invitee_id = ${row['invitee_id']} RETURNING *`.execute(db);
}
