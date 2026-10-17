// B2-02e / BR-FUND-19: storage fixtures, not an alternative invariant implementation.
// The public test-database capability suffices: all corruptions are legal INSERTs;
// no append-only trigger, constraint, or business-role permission is disabled.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { subFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const DAY = '2032-06-15';
export const APP = 'invariant-app-a';
export const OTHER_APP = 'invariant-app-b';
export type Invariant = '01' | '02' | '03' | '04' | '07';
export type Row = Record<string, unknown>;
export interface Account {
  id: string;
  app_id: string;
  owner_id: string;
  owner_type: string;
  subject: string;
}
export interface Voucher {
  id: string;
  app_id: string;
  uniq_key: string;
  order_key: string | null;
  beneficiary_user_id: string | null;
  role: string | null;
  voucher_kind: string | null;
}
export interface Result {
  invariant: string;
  checked_rows: bigint;
  scope: 'account' | 'global' | 'none';
  app_id: string | null;
  account_id: string | null;
  detail: unknown;
}
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export interface Fixture {
  db: Kysely<DB>;
  check(date?: string): Promise<Result[]>;
}

function source(code: Invariant): string {
  const directory = new URL('../../../../../db/invariants/ledger/', import.meta.url);
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const matches = names.filter((name) => name.startsWith(`${code}_`) && name.endsWith('.sql'));
  // No SQL placeholder: SQL is append-only and belongs to the implementation phase.
  // Missing SQL is an assertion failure, never ENOENT or an unresolved module.
  expect(matches, `BR-FUND-19 ${code}: exactly one ${code}_*.sql`).toHaveLength(1);
  const raw = readFileSync(new URL(matches[0]!, directory), 'utf8');
  // Keep quoted text intact while removing comments, including comments after the final ';'.
  const text = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
  const tokens = text.replace(/'(?:''|[^'])*'/g, ' ');
  expect(tokens.trim()).toMatch(/^(?:SELECT|WITH)\b/i);
  expect(tokens.trim().replace(/;\s*$/, '')).not.toContain(';');
  expect(tokens).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
  );
  expect(tokens).not.toMatch(
    /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
  );
  return text.trim().replace(/;\s*$/, '');
}

// A fresh clone per scenario prevents intentionally bad rows from contaminating later tests.
// Only *.int.test.ts imports @couli/db/testing and supplies the factory.
export async function scenario(
  create: () => Promise<Database>,
  code: Invariant,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const query = source(code);
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    await run({
      db,
      async check(date = DAY) {
        return reader
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await sql`SET TRANSACTION READ ONLY`.execute(trx);
            await sql`SELECT set_config('couli.check_date', ${date}, true)`.execute(trx);
            const result = await sql.raw<Result>(query).execute(trx);
            expect(
              result.rows.length,
              'a sentinel or at least one difference is mandatory',
            ).toBeGreaterThan(0);
            for (const row of result.rows) {
              expect(Object.keys(row).sort()).toEqual([
                'account_id',
                'app_id',
                'checked_rows',
                'detail',
                'invariant',
                'scope',
              ]);
              expect(row.invariant).toBe(code);
              expect(typeof row.checked_rows).toBe('bigint');
              expect(row.checked_rows, 'D18: empty checks fail the fixture').toBeGreaterThan(0n);
              expect(row.checked_rows).toBe(result.rows[0]!.checked_rows);
              expect(['account', 'global', 'none']).toContain(row.scope);
            }
            const types = await sql
              .raw<Row>(
                `SELECT pg_typeof(invariant)::text AS invariant,
            pg_typeof(checked_rows)::text AS checked_rows, pg_typeof(scope)::text AS scope,
            pg_typeof(app_id)::text AS app_id, pg_typeof(account_id)::text AS account_id,
            pg_typeof(detail)::text AS detail FROM (${query}\n) AS result LIMIT 1`,
              )
              .execute(trx);
            expect(types.rows).toEqual([
              {
                invariant: 'text',
                checked_rows: 'bigint',
                scope: 'text',
                app_id: 'text',
                account_id: 'uuid',
                detail: 'jsonb',
              },
            ]);
            return result.rows;
          });
      },
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

export async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function account(db: Kysely<DB>, values: Partial<Account> = {}): Promise<Account> {
  const row = {
    id: randomUUID(),
    app_id: APP,
    owner_type: 'user',
    owner_id: randomUUID(),
    subject: 'USER_BALANCE',
    ...values,
  };
  await insert(db, 'ledger_accounts', row);
  return row;
}

export async function platform(db: Kysely<DB>, subject = 'UNION_RECEIVABLE:taobao', appId = APP) {
  return account(db, { app_id: appId, owner_type: 'platform', owner_id: 'platform', subject });
}

export async function voucher(db: Kysely<DB>, values: Row = {}): Promise<Voucher> {
  const row = {
    id: randomUUID(),
    app_id: APP,
    biz_type: 'order',
    biz_id: randomUUID(),
    uniq_key: `fixture:${randomUUID()}`,
    accounting_date: DAY,
    operator: 'system',
    order_key: null,
    beneficiary_user_id: null,
    role: null,
    voucher_kind: null,
    ...values,
  };
  await insert(db, 'ledger_vouchers', row);
  return row as Voucher;
}

export async function entry(
  db: Kysely<DB>,
  a: Account,
  v: Voucher,
  amount: bigint,
  values: Row = {},
): Promise<void> {
  await insert(db, 'ledger_entries', {
    app_id: a.app_id,
    account_id: a.id,
    voucher_id: v.id,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: 'REBATE_CREDIT',
    balance_after_fen: a.owner_type === 'user' ? subFen(0n, amount) : null,
    account_version: a.owner_type === 'user' ? 1n : null,
    booked_at: '2032-06-15T08:00:00Z',
    ...values,
  });
}

export async function pair(
  db: Kysely<DB>,
  user: Account,
  counter: Account,
  v: Voucher,
  amount: bigint,
  values: Row = {},
): Promise<void> {
  await entry(db, user, v, amount, values);
  await entry(db, counter, v, subFen(0n, amount), {
    ledger_type: values['ledger_type'] ?? 'REBATE_CREDIT',
    sub_type: values['sub_type'] ?? null,
  });
}

export async function balance(db: Kysely<DB>, a: Account, available: bigint, frozen = 0n) {
  await insert(db, 'account_balances', {
    app_id: a.app_id,
    account_id: a.id,
    available_fen: available,
    frozen_fen: frozen,
    version: 1n,
  });
}

export async function daily(db: Kysely<DB>, a: Account, values: Row = {}) {
  await insert(db, 'daily_balances', {
    app_id: a.app_id,
    account_id: a.id,
    sub_account: 'available',
    accounting_date: DAY,
    opening_fen: 0n,
    debit_fen: 0n,
    credit_fen: 0n,
    closing_fen: 0n,
    computed_at: '2032-06-16T01:00:00+08:00',
    ...values,
  });
}

export function clean(rows: Result[]): void {
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scope: 'none', app_id: null, account_id: null, detail: null });
}

export function differences(rows: Result[], scope: 'account' | 'global'): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.scope).toBe(scope);
    expect(typeof row.app_id).toBe('string');
    if (scope === 'global') expect(row.account_id).toBeNull();
    else expect(row.account_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.detail).toBeTypeOf('object');
    expect(row.detail).not.toBeNull();
    expect(Object.keys(row.detail as object).length).toBeGreaterThan(0);
  }
}

// Detail key names are intentionally free; require meaningful values and related keys.
export function detailContains(rows: Result[], ...values: (string | bigint)[]): void {
  function leaves(value: unknown): string[] {
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves);
    return [String(value)];
  }
  const actual = rows.flatMap((row) => leaves(row.detail));
  for (const value of values)
    expect(actual, `detail must explain ${String(value)}`).toContain(String(value));
}
