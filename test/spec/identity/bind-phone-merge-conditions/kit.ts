// Kit of B1-20e: the BR-ID-06 merge conditions read from real data (规划/08 BR-ID-06 并号 OPS-04;
// orchestrator ruling §9.2 / §9.3). Built on B1-20a's HTTP kit (real AppModule, PG, Redis; its
// accountAssets fault switches stay off). Fixtures insert rows straight into app.claims,
// app.ledger_accounts / ledger_vouchers / ledger_entries and app.deletion_requests, within their
// constraints. Every apps/api module is imported dynamically; static imports are types only.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { ROOT } from '../../risk/signature/kit.ts';
import type { Fixture, Kit } from '../bind-phone/http-kit.ts';

type LedgerIndex = typeof import('../../../../apps/api/src/modules/ledger/index.ts');

/** The ledger's public exit (apps/api/src/modules/ledger/index.ts). */
export async function ledger(): Promise<LedgerIndex> {
  return (await import(new URL('apps/api/src/modules/ledger/index.ts', ROOT).href)) as LedgerIndex;
}

/** Clears the SMS resend interval before a second code to the same number. */
export const RESEND_GAP_MS = 120_000;

/** Every app.claims status (claims_status_check). */
export const CLAIM_STATUSES = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

const EVIDENCE: Readonly<Record<ClaimStatus, string | null>> = {
  submitted: null,
  auto_matched: 'strong',
  manual_review: 'weak',
  approved: 'strong',
  rejected: 'none',
  cancelled: 'weak',
};

/**
 * The current account binds the number another account owns: the bind code is consumed and
 * nothing moves on either side (users, user_oauth, sessions, the ledger, claims, deletion requests).
 */
export async function attempt(f: Fixture) {
  const code = await f.send();
  const before = await everything(f);
  const response = await f.bind({ phone: f.number, code });
  expect(await everything(f)).toEqual(before);
  expect(await f.stillValid(code)).toBe(false);
  return response;
}

/** A second binding attempt with a fresh code, after the resend interval. */
export async function again(kit: Kit, f: Fixture) {
  kit.clock.advanceMs(RESEND_GAP_MS);
  return attempt(f);
}

async function everything(f: Fixture) {
  return {
    ...(await f.snapshot()),
    ledger: await ledgerRows(f.db),
    claims: await f.db
      .selectFrom('claims')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    deletions: await f.db
      .selectFrom('deletion_requests')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** Every ledger row of every app (the reader must neither open accounts nor book). */
export async function ledgerRows(db: Kysely<DB>) {
  const accounts = await sql<Record<string, unknown>>`SELECT * FROM app.ledger_accounts
    ORDER BY id`.execute(db);
  const vouchers = await sql<Record<string, unknown>>`SELECT * FROM app.ledger_vouchers
    ORDER BY id`.execute(db);
  const entries = await sql<Record<string, unknown>>`SELECT * FROM app.ledger_entries
    ORDER BY id`.execute(db);
  return { accounts: accounts.rows, vouchers: vouchers.rows, entries: entries.rows };
}

/** One claim (找回申请) of `user` as the applicant, in `status`. */
export async function claim(kit: Kit, f: Fixture, user: string, status: ClaimStatus) {
  const id = randomUUID();
  const now = kit.clock.now();
  await sql`INSERT INTO app.claims
      (id, app_id, user_id, platform, order_no, order_no_type, paid_date, evidence_level, status,
       created_at, updated_at)
    VALUES (${id}, ${f.appId}, ${user}, 'taobao', ${`claim-${randomUUID()}`}, 'sub', '2026-10-10',
      ${EVIDENCE[status]}, ${status}, ${now}, ${now})`.execute(f.db);
  return id;
}

/** The USER_BALANCE account of `owner` in `appId` (no entry). */
export async function balanceAccount(db: Kysely<DB>, appId: string, owner: string) {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}, ${appId}, 'user', ${owner}, 'USER_BALANCE')`.execute(db);
  return id;
}

async function platformAccount(db: Kysely<DB>, appId: string) {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}, ${appId}, 'platform', 'platform',
      ${`FIXTURE_${randomBytes(6).toString('hex')}`})`.execute(db);
  return id;
}

export interface EntryOptions {
  ledgerType?: string;
  subAccount?: 'available' | 'frozen';
  /** Signed fen of the user's entry; the platform side gets the opposite. */
  amountFen?: number;
}

/**
 * One balanced voucher: an entry on `account` (a user's balance account of `appId`) and the
 * opposite entry on a fresh platform account of the same app.
 */
export async function entry(
  kit: Kit,
  db: Kysely<DB>,
  appId: string,
  account: string,
  options: EntryOptions = {},
) {
  const voucher = randomUUID();
  const at = kit.clock.now();
  const type = options.ledgerType ?? 'REBATE_CREDIT';
  const amount = options.amountFen ?? -100;
  const platform = await platformAccount(db, appId);
  await sql`INSERT INTO app.ledger_vouchers
      (id, app_id, biz_type, biz_id, uniq_key, accounting_date, operator)
    VALUES (${voucher}, ${appId}, 'fixture', ${voucher}, ${`fixture:${voucher}`}, '2026-10-16',
      'system')`.execute(db);
  await sql`INSERT INTO app.ledger_entries
      (app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type, booked_at)
    VALUES
      (${appId}, ${voucher}, ${account}, ${options.subAccount ?? 'available'}, ${amount}, ${type},
        ${at}),
      (${appId}, ${voucher}, ${platform}, 'available', ${-amount}, ${type}, ${at})`.execute(db);
  return voucher;
}

/** Another app id that no fixture of this file uses. */
export const otherApp = () => `bpx_${randomBytes(10).toString('hex')}`;

export type DeletionStatus = 'cooling' | 'overdue_cooling' | 'processing' | 'cancelled';

const DAY_MS = 86_400_000;

/**
 * A deletion request of `user`. users.status is left as it is (normal for a seeded owner), so the
 * merge offer can only be refused through the request's stage, not through users.status.
 */
export async function deletion(kit: Kit, f: Fixture, user: string, status: DeletionStatus) {
  const id = randomUUID();
  const now = kit.clock.now().getTime();
  const past = status === 'overdue_cooling' || status === 'processing';
  const applyAt = new Date(past ? now - 16 * DAY_MS : now - 2 * DAY_MS);
  const coolingUntil = new Date(applyAt.getTime() + 15 * DAY_MS);
  const cancelled = status === 'cancelled';
  await sql`INSERT INTO app.deletion_requests
      (id, app_id, user_id, status, apply_at, cooling_until, cancelled_at, cancel_reason,
       processed_at, balance_snapshot_fen)
    VALUES (${id}, ${f.appId}, ${user}, ${status === 'overdue_cooling' ? 'cooling' : status},
      ${applyAt}, ${coolingUntil}, ${cancelled ? new Date(applyAt.getTime() + 3_600_000) : null},
      ${cancelled ? 'user' : null}, null, 0)`.execute(f.db);
  return id;
}
