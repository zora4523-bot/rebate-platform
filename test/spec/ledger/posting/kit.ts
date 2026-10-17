import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import {
  createLedger,
  type Ledger,
  type PostingEntry,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const TIMEOUT = 120_000;
export const INSTANT = '2032-06-15T15:59:59.999Z';
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: TestDatabase;
  db: Kysely<DB>;
  left: Kysely<DB>;
  right: Kysely<DB>;
  control: Kysely<DB>;
}
export async function open(create: () => Promise<TestDatabase>): Promise<Harness> {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  return {
    database,
    db: createDb({ connectionString, max: 2 }),
    left: createDb({ connectionString, max: 1 }),
    right: createDb({ connectionString, max: 1 }),
    control: createDb({ connectionString, max: 1 }),
  };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([h.db, h.left, h.right, h.control].map(destroyDb));
  await h.database.drop();
}
export function context() {
  const clock = new FixedClock(INSTANT);
  // In the red phase this is deliberately called inside each it, never in a hook.
  return { clock, ledger: createLedger({ clock }), appId: `posting-${randomUUID()}` };
}
export async function account(
  db: Kysely<DB>,
  ledger: Ledger,
  appId: string,
  userId: string = randomUUID(),
) {
  return db.transaction().execute((trx) => ledger.openUserAccount(trx, { appId, userId }));
}
export function entry(
  accountId: string,
  amount: bigint,
  ledgerType = 'REBATE_CREDIT',
): PostingEntry {
  return {
    account: { ownerType: 'user', accountId },
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: ledgerType,
    sub_type: null,
    income_type: 'SERVICE_FEE',
  };
}
export function voucher(
  appId: string,
  accountId: string,
  signedUserAmount: bigint,
  overrides: Partial<PostingVoucher> = {},
): PostingVoucher {
  return {
    appId,
    uniqKey: `POST:${randomUUID()}`,
    bizType: 'TEST_POSTING',
    bizId: randomUUID(),
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: [
      entry(accountId, signedUserAmount),
      {
        ...entry(accountId, -signedUserAmount),
        account: { ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' },
        income_type: null,
      },
    ],
    ...overrides,
  };
}
export async function post(
  db: Kysely<DB>,
  ledger: Ledger,
  userIds: readonly string[],
  v: PostingVoucher,
) {
  return db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId: v.appId, userIds });
    return ledger.post(trx, v);
  });
}
export async function snapshot(db: Kysely<DB>, appId: string) {
  const [accounts, balances, vouchers, entries] = await Promise.all([
    db
      .selectFrom('ledger_accounts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    db.selectFrom('ledger_entries').selectAll().where('app_id', '=', appId).orderBy('id').execute(),
  ]);
  return { accounts, balances, vouchers, entries };
}
export async function bounded(trx: Transaction<DB>): Promise<number> {
  await sql`SET LOCAL statement_timeout = '8s'`.execute(trx);
  await sql`SET LOCAL lock_timeout = '6s'`.execute(trx);
  const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.pid;
}
export async function waitBlocked(db: Kysely<DB>, waiter: number, holder: number): Promise<void> {
  // Observe a real server-side wait, never infer concurrency from a sleep.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const result = await sql<{ blocked: boolean }>`
      SELECT ${holder} = ANY(pg_blocking_pids(${waiter})) AS blocked`.execute(db);
    if (result.rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backend ${waiter} did not wait for ${holder}`);
}
