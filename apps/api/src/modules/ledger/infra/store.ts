// SQL of the ledger tables (app.ledger_accounts, ledger_vouchers, ledger_entries,
// account_balances). Every function runs on the handle it is given; none opens a transaction.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export const USER_SUBJECT = 'USER_BALANCE';
export const PLATFORM_OWNER = 'platform';

export interface BalanceRow {
  readonly app_id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly version: bigint;
  readonly negative_since: string | null;
}

function balances(db: Kysely<DB>, appId: string) {
  return (
    db
      .selectFrom('account_balances as ab')
      .innerJoin('ledger_accounts as la', (join) =>
        join.onRef('la.app_id', '=', 'ab.app_id').onRef('la.id', '=', 'ab.account_id'),
      )
      .select([
        'ab.app_id',
        'ab.account_id',
        'la.owner_id as user_id',
        'ab.available_fen',
        'ab.frozen_fen',
        'ab.version',
      ])
      // DateStyle-independent YYYY-MM-DD (a +08:00 accounting date, never a JS Date).
      .select(sql<string | null>`to_char(ab.negative_since, 'YYYY-MM-DD')`.as('negative_since'))
      .where('ab.app_id', '=', appId)
      .where('la.owner_type', '=', 'user')
      .where('la.subject', '=', USER_SUBJECT)
      .orderBy('ab.account_id')
  );
}

/** Plain read of the cache, ordered by account_id. */
export async function readBalancesByUser(
  db: Kysely<DB>,
  appId: string,
  userIds: readonly string[],
): Promise<BalanceRow[]> {
  if (userIds.length === 0) return [];
  return balances(db, appId).where('la.owner_id', 'in', userIds).execute();
}

/**
 * BR-FUND-16 加锁流程 ③: one statement, ORDER BY account_id below the row-locking step, so
 * PostgreSQL takes the balance-row locks in ascending account_id order. Only account_balances
 * rows are locked (FOR UPDATE OF ab); ledger_accounts and platform subjects never are.
 */
export async function lockBalancesByUser(
  trx: Transaction<DB>,
  appId: string,
  userIds: readonly string[],
): Promise<BalanceRow[]> {
  if (userIds.length === 0) return [];
  return balances(trx, appId).where('la.owner_id', 'in', userIds).forUpdate(['ab']).execute();
}

/**
 * Re-read rows this transaction already holds. NOWAIT: post never waits on a balance lock, so
 * it can never take one out of order; a row held elsewhere fails fast instead.
 */
export async function relockHeldBalances(
  trx: Transaction<DB>,
  appId: string,
  accountIds: readonly string[],
): Promise<BalanceRow[]> {
  if (accountIds.length === 0) return [];
  return balances(trx, appId)
    .where('ab.account_id', 'in', accountIds)
    .forUpdate(['ab'])
    .noWait()
    .execute();
}

/** Ids among accountIds that are USER_BALANCE accounts of this app. */
export async function userAccountsOfApp(
  trx: Transaction<DB>,
  appId: string,
  accountIds: readonly string[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('ledger_accounts')
    .select('id')
    .where('app_id', '=', appId)
    .where('owner_type', '=', 'user')
    .where('subject', '=', USER_SUBJECT)
    .where('id', 'in', accountIds)
    .execute();
  return new Set(rows.map((row) => row.id));
}

/** Creates the user's account and zero balance row if absent (ON CONFLICT DO NOTHING). */
export async function ensureUserAccount(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<void> {
  await trx
    .insertInto('ledger_accounts')
    .values({
      id: randomUUID(),
      app_id: appId,
      owner_type: 'user',
      owner_id: userId,
      subject: USER_SUBJECT,
    })
    .onConflict((oc) => oc.columns(['app_id', 'owner_type', 'owner_id', 'subject']).doNothing())
    .execute();
  const account = await trx
    .selectFrom('ledger_accounts')
    .select('id')
    .where('app_id', '=', appId)
    .where('owner_type', '=', 'user')
    .where('owner_id', '=', userId)
    .where('subject', '=', USER_SUBJECT)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('account_balances')
    .values({
      account_id: account.id,
      app_id: appId,
      available_fen: 0n,
      frozen_fen: 0n,
      version: 0n,
      negative_since: null,
    })
    .onConflict((oc) => oc.column('account_id').doNothing())
    .execute();
}

async function platformIds(
  trx: Transaction<DB>,
  appId: string,
  subjects: readonly string[],
): Promise<Map<string, string>> {
  const rows = await trx
    .selectFrom('ledger_accounts')
    .select(['id', 'subject'])
    .where('app_id', '=', appId)
    .where('owner_type', '=', 'platform')
    .where('owner_id', '=', PLATFORM_OWNER)
    .where('subject', 'in', subjects)
    .execute();
  return new Map(rows.map((row) => [row.subject, row.id]));
}

/**
 * D7: platform accounts are created lazily on first posting. Existing subjects are only read;
 * missing ones are inserted in subject order (two first postings cannot wait on each other).
 * Platform rows are never locked.
 */
export async function ensurePlatformAccounts(
  trx: Transaction<DB>,
  appId: string,
  subjects: readonly string[],
): Promise<Map<string, string>> {
  if (subjects.length === 0) return new Map();
  const found = await platformIds(trx, appId, subjects);
  const missing = subjects.filter((subject) => !found.has(subject)).sort();
  if (missing.length === 0) return found;
  await trx
    .insertInto('ledger_accounts')
    .values(
      missing.map((subject) => ({
        id: randomUUID(),
        app_id: appId,
        owner_type: 'platform',
        owner_id: PLATFORM_OWNER,
        subject,
      })),
    )
    .onConflict((oc) => oc.columns(['app_id', 'owner_type', 'owner_id', 'subject']).doNothing())
    .execute();
  const all = await platformIds(trx, appId, subjects);
  for (const subject of subjects) {
    if (!all.has(subject)) throw new Error(`ledger: platform account ${subject} not created`);
  }
  return all;
}

export async function findVoucherId(
  db: Kysely<DB>,
  appId: string,
  uniqKey: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('ledger_vouchers')
    .select('id')
    .where('app_id', '=', appId)
    .where('uniq_key', '=', uniqKey)
    .executeTakeFirst();
  return row?.id;
}

/** The stored voucher header a reversal copies (BR-FUND-15/16), by (app_id, uniq_key). */
export interface VoucherRow {
  readonly id: string;
  readonly biz_type: string;
  readonly biz_id: string;
  readonly uniq_key: string;
  readonly operator: string;
  readonly memo: string | null;
  readonly order_key: string | null;
  readonly beneficiary_user_id: string | null;
  readonly role: string | null;
  readonly voucher_kind: string | null;
}

export async function findVoucher(
  db: Kysely<DB>,
  appId: string,
  uniqKey: string,
): Promise<VoucherRow | undefined> {
  return db
    .selectFrom('ledger_vouchers')
    .select([
      'id',
      'biz_type',
      'biz_id',
      'uniq_key',
      'operator',
      'memo',
      'order_key',
      'beneficiary_user_id',
      'role',
      'voucher_kind',
    ])
    .where('app_id', '=', appId)
    .where('uniq_key', '=', uniqKey)
    .executeTakeFirst();
}

/** One stored entry with the owner of its account, so it can be posted again by reference. */
export interface StoredEntry {
  readonly account_id: string;
  readonly owner_type: string;
  readonly subject: string;
  readonly sub_account: string;
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly income_type: string | null;
}

/** All entries of one voucher of this app, in insertion order. */
export async function voucherEntries(
  db: Kysely<DB>,
  appId: string,
  voucherId: string,
): Promise<StoredEntry[]> {
  return db
    .selectFrom('ledger_entries as le')
    .innerJoin('ledger_accounts as la', (join) =>
      join.onRef('la.app_id', '=', 'le.app_id').onRef('la.id', '=', 'le.account_id'),
    )
    .select([
      'le.account_id',
      'la.owner_type',
      'la.subject',
      'le.sub_account',
      'le.amount_fen',
      'le.ledger_type',
      'le.sub_type',
      'le.income_type',
    ])
    .where('le.app_id', '=', appId)
    .where('le.voucher_id', '=', voucherId)
    .orderBy('le.id')
    .execute();
}

export interface VoucherInsert {
  readonly id: string;
  readonly app_id: string;
  readonly biz_type: string;
  readonly biz_id: string;
  readonly uniq_key: string;
  readonly accounting_date: string;
  readonly operator: string;
  readonly memo: string | null;
  readonly order_key: string | null;
  readonly beneficiary_user_id: string | null;
  readonly role: string | null;
  readonly voucher_kind: string | null;
}

export interface EntryInsert {
  readonly app_id: string;
  readonly voucher_id: string;
  readonly account_id: string;
  readonly sub_account: 'available' | 'frozen';
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly income_type: string | null;
  readonly balance_after_fen: bigint | null;
  readonly account_version: bigint | null;
  readonly booked_at: Date;
}

export async function insertVoucher(trx: Transaction<DB>, voucher: VoucherInsert): Promise<void> {
  await trx.insertInto('ledger_vouchers').values(voucher).execute();
}

export async function insertEntries(
  trx: Transaction<DB>,
  entries: readonly EntryInsert[],
): Promise<void> {
  await trx.insertInto('ledger_entries').values(entries).execute();
}

export interface BalanceUpdate {
  readonly account_id: string;
  readonly expected_version: bigint;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly version: bigint;
  readonly negative_since: string | null;
}

/** Compare-and-set on version under the held row lock; returns whether the row was written. */
export async function updateBalance(
  trx: Transaction<DB>,
  appId: string,
  update: BalanceUpdate,
): Promise<boolean> {
  const result = await trx
    .updateTable('account_balances')
    .set({
      available_fen: update.available_fen,
      frozen_fen: update.frozen_fen,
      version: update.version,
      negative_since: update.negative_since,
    })
    .where('app_id', '=', appId)
    .where('account_id', '=', update.account_id)
    .where('version', '=', update.expected_version)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** The (app_id, uniq_key) unique constraint of ledger_vouchers (BR-FUND-16). */
export function isUniqKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === 'ledger_vouchers_uniq_key_key';
}

let savepointSeq = 0;

/**
 * Runs fn inside a savepoint of the caller's transaction: on any error the work since the
 * savepoint is rolled back (locks taken before it are kept) and the transaction stays usable.
 */
export async function inSavepoint<T>(trx: Transaction<DB>, fn: () => Promise<T>): Promise<T> {
  savepointSeq = (savepointSeq + 1) % 1_000_000_000;
  const name = sql.raw(`couli_ledger_${savepointSeq}`);
  await sql`SAVEPOINT ${name}`.execute(trx);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(trx);
    throw error;
  }
  await sql`RELEASE SAVEPOINT ${name}`.execute(trx);
  return result;
}
