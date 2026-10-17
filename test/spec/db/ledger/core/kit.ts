// B2-02c: storage-only fixtures; no ledger service or business calculations.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TABLES = [
  'ledger_accounts',
  'ledger_vouchers',
  'ledger_entries',
  'account_balances',
] as const;
export const ROLES = ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint'] as const;
export const UPDATE_COLUMNS = ['available_fen', 'frozen_fen', 'negative_since', 'version'];
export const TIMEOUT = 60_000;
export const BOOKED_AT = '2032-06-15T08:00:00Z';
export type Row = Record<string, unknown>;
type Role = (typeof ROLES)[number];
interface OneShotDatabase {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: OneShotDatabase;
  roles: Record<Role, Kysely<DB>>;
  app: Kysely<DB>;
}

export async function open(create: () => Promise<OneShotDatabase>): Promise<Harness> {
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

// Called by each test, never a hook: missing migration => assertion, not undefined_table.
export async function ready(db: Kysely<DB>): Promise<void> {
  for (const table of TABLES) {
    const result = await sql<{ kind: string }>`SELECT c.relkind::text AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = ${table}`.execute(db);
    expect(result.rows, `0037 must create app.${table}`).toEqual([
      { kind: table === 'ledger_entries' ? 'p' : 'r' },
    ]);
  }
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code)) {
      throw error;
    }
    return code;
  }
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function columns(db: Kysely<DB>, table: string) {
  return (
    await sql<{ name: string; type: string; nullable: string; default_value: string | null }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
      column_default AS default_value FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ${table} ORDER BY ordinal_position
  `.execute(db)
  ).rows;
}

export function accountRow(values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `ledger-${randomUUID()}`,
    owner_type: 'user',
    owner_id: randomUUID(),
    subject: 'USER_BALANCE',
    ...values,
  };
}

export function voucherRow(appId: unknown, values: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: appId,
    biz_type: 'ADMIN_ADJUST',
    biz_id: randomUUID(),
    uniq_key: `ADJ:${randomUUID()}`,
    accounting_date: '2032-06-15',
    operator: 'system',
    memo: 'synthetic ledger fixture',
    ...values,
  };
}

export function entryRow(account: Row, voucher: Row, values: Row = {}): Row {
  return {
    app_id: account['app_id'],
    account_id: account['id'],
    voucher_id: voucher['id'],
    sub_account: 'available',
    amount_fen: -617n,
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    income_type: 'SERVICE_FEE',
    balance_after_fen: 617n,
    account_version: 1,
    booked_at: BOOKED_AT,
    ...values,
  };
}

export function balanceRow(account: Row, values: Row = {}): Row {
  return {
    app_id: account['app_id'],
    account_id: account['id'],
    available_fen: 0n,
    frozen_fen: 0n,
    negative_since: null,
    version: 0,
    ...values,
  };
}

export async function parents(db: Kysely<DB>, values: Row = {}) {
  const account = accountRow(values);
  const voucher = voucherRow(account['app_id']);
  expect(await sqlState(insert(db, 'ledger_accounts', account)), 'valid account').toBe('ok');
  expect(await sqlState(insert(db, 'ledger_vouchers', voucher)), 'valid voucher').toBe('ok');
  return { account, voucher };
}
