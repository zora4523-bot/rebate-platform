// B2-02d: storage fixtures only; no daily runner or balance calculation.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const COMPUTED_AT = '2032-06-16T01:00:00+08:00';
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
type Role = (typeof ROLES)[number];
export type Row = Record<string, unknown>;
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  roles: Record<Role, Kysely<DB>>;
  app: Kysely<DB>;
}

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Kysely<DB>>;
  return { database, roles, app: roles.couli_app };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.roles).map((db) => destroyDb(db)));
  await h.database.drop();
}

// Run inside every test, not a hook: absent 0038 yields an assertion failure.
export async function ready(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass('app.daily_balances') IS NOT NULL AS present
  `.execute(db);
  expect(result.rows, '0038 must create app.daily_balances').toEqual([{ present: true }]);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function account(db: Kysely<DB>, appId = `daily-${randomUUID()}`) {
  const row = {
    id: randomUUID(),
    app_id: appId,
    owner_type: 'user',
    owner_id: randomUUID(),
    subject: 'USER_BALANCE',
  };
  expect(await sqlState(insert(db, 'ledger_accounts', row)), 'valid parent account').toBe('ok');
  return row;
}

export function dailyRow(parent: { id: string; app_id: string }, values: Row = {}): Row {
  return {
    app_id: parent.app_id,
    account_id: parent.id,
    sub_account: 'available',
    accounting_date: '2032-06-15',
    opening_fen: 0n,
    debit_fen: 0n,
    credit_fen: 0n,
    closing_fen: 0n,
    computed_at: COMPUTED_AT,
    ...values,
  };
}
