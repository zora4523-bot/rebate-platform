// B1-02zn GET /v1/me balance from ledger (BR-FUND-18, 拍板第二批 §8 ADD-06): fixtures over the
// same api app as test/spec/identity/me (real AppModule, real PG + Redis, HTTP through inject).
// Rows are written directly (test-owned setup) before the first GET of the user; every fixture
// uses a fresh app_id. Expected amounts are written out in each case, never computed by the code
// under test. Sources: contracts/openapi.yaml MeBalance / WalletSummary; brief §9.2, §9.3.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { account, balance, pair, platform, voucher } from '../../db/ledger/invariants/kit.ts';
import { AT, seed, type Person } from '../../settlement/pending-earnings/fixtures.ts';
import type { Response } from '../sms-codes/http-kit.ts';
import type { Kit } from '../me/http-kit.ts';

export const WALLET = '/v1/wallet/summary';

/** The three MeBalance fields (contract MeBalance). */
export interface MeBalance {
  available_fen: number;
  withdrawable_fen: number;
  estimated_total_fen: number;
}

export const ZERO: MeBalance = { available_fen: 0, withdrawable_fen: 0, estimated_total_fen: 0 };

/** The WalletSummary fields this task compares; the rest are left as they come. */
export type WalletSummary = MeBalance & Record<string, unknown>;

function schemaOf(kit: Kit, path: string, status: string): Record<string, unknown> {
  return kit.document.paths[path]!['get']!.responses[status]!.content['application/json']!.schema;
}

/** GET /v1/wallet/summary data: HTTP 200, code 0, body valid against the contract. */
export function wallet(kit: Kit, response: Response): WalletSummary {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: WalletSummary }>();
  expect(body).toMatchObject({ code: 0 });
  const validate = kit.compile({ schema: schemaOf(kit, WALLET, '200'), httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

/** A 50001 answer of GET /v1/wallet/summary (HTTP 500, contract 5XX envelope). */
export function walletServerError(kit: Kit, response: Response): void {
  expect(response.statusCode).toBe(500);
  const body = response.json<{ code: number }>();
  expect(body).toMatchObject({ code: 50001 });
  const validate = kit.compile({ schema: schemaOf(kit, WALLET, '5XX'), httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

/** The MeBalance-named fields of a wallet summary. */
export function same(summary: WalletSummary): MeBalance {
  return {
    available_fen: summary.available_fen,
    withdrawable_fen: summary.withdrawable_fen,
    estimated_total_fen: summary.estimated_total_fen,
  };
}

export interface LedgerInput {
  appId: string;
  userId: string;
  /** account_balances.available_fen of the user's USER_BALANCE account. */
  available: bigint;
  frozen?: bigint;
  /**
   * A REBATE_CREDIT voucher of this many fen booked to the user (liability credit: negative
   * amount on the user's account, the opposite on a platform account of the same app).
   */
  credit?: bigint;
}

/** The user's balance account in the app, its account_balances row and optional credit entries. */
export async function ledgerBalance(kit: Kit, input: LedgerInput): Promise<void> {
  const db = kit.suite.db;
  const user = await account(db, { app_id: input.appId, owner_id: input.userId });
  if (input.credit !== undefined) {
    // A per-call platform subject keeps several credited users of one app apart.
    const counter = await platform(
      db,
      `UNION_RECEIVABLE:fixture-${randomBytes(4).toString('hex')}`,
      input.appId,
    );
    const credited = await voucher(db, { app_id: input.appId });
    await pair(db, user, counter, credited, -input.credit, { ledger_type: 'REBATE_CREDIT' });
  }
  await balance(db, user, input.available, input.frozen ?? 0n);
}

/** A published commission rule version of the app (what the commission split rows refer to). */
export async function ruleVersion(kit: Kit, appId: string): Promise<string> {
  const id = randomUUID();
  await kit.suite.db
    .withSchema('app')
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: id,
      status: 'published',
      effective_from: AT,
      indirect_enabled: true,
      created_at: AT,
    })
    .execute();
  return id;
}

export type OrderKind = 'estimated' | 'waiting_hold' | 'waiting';

/**
 * One taobao order of `owner` in the app with N = 1000 fen and a 15 % reserve (base 850 fen),
 * split by `people` (default: the owner alone as self at 50 % → 425 fen):
 * - estimated: ESTIMATED + PAID (an estimate share);
 * - waiting_hold: WAITING + RECEIVED, settle_period 2026-10, hold (a paused pending credit);
 * - waiting: WAITING + RECEIVED, settle_period 2026-10, not held (reads the credit config).
 */
export async function order(
  kit: Kit,
  input: {
    appId: string;
    owner: string;
    ruleVersionId: string;
    kind?: OrderKind;
    people?: readonly Person[];
  },
): Promise<string> {
  const kind = input.kind ?? 'estimated';
  const status =
    kind === 'estimated'
      ? {}
      : {
          rebate_status: 'WAITING',
          platform_status: 'RECEIVED',
          settle_period: '2026-10',
          hold: kind === 'waiting_hold',
        };
  return seed(
    kit.suite.db,
    { appId: input.appId, userId: input.owner, ruleVersionId: input.ruleVersionId },
    { order: status, ...(input.people === undefined ? {} : { people: input.people }) },
  );
}

/** The user's ledger accounts in the app (a read must never open one). */
export function accountsOf(kit: Kit, appId: string, userId: string) {
  return kit.suite.db
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select('id')
    .where('app_id', '=', appId)
    .where('owner_id', '=', userId)
    .execute();
}
