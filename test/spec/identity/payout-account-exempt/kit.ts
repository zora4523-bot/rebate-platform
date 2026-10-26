// Helpers of the B2-05j rule tests (BR-WDR-02 细则「实名更正后的失效与重绑」; 04 §3.2
// payout_account_changes.limit_exempt_reason). App, PG and fixtures come from the B1-13e kit.
// limit_exempt_reason is not in the generated DB types until the orchestrator's snapshot, so every
// read or write that names it is raw SQL, and each test checks the column itself first (an
// assertion, not a database error, when it is missing).
import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { ROOT, type Fixture, type Kit } from '../payout-account/kit.ts';

type Invalidation =
  typeof import('../../../../apps/api/src/modules/identity/application/payout-account-invalidation.ts');

export const EXEMPT = 'realname_correction';
export const OPERATOR = 'admin:1001';
export const CHECK_NAME = 'payout_account_changes_limit_exempt_reason_check';

interface ColumnShape {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

/** The column exists as a nullable text without default (04 §3.2: null or realname_correction). */
export async function exemptColumn(kit: Kit) {
  const rows = await sql<ColumnShape>`
    SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'payout_account_changes'
      AND column_name = 'limit_exempt_reason'`.execute(kit.db);
  expect(rows.rows, 'payout_account_changes.limit_exempt_reason').toEqual([
    { data_type: 'text', is_nullable: 'YES', column_default: null },
  ]);
}

/** Appends a change row with the given limit_exempt_reason (default realname_correction). */
export async function exemptChange(
  kit: Kit,
  f: Fixture,
  options: { at?: Date; reason?: string | null; handle?: Kysely<DB> } = {},
) {
  const at = options.at ?? kit.clock.now();
  const reason = options.reason === undefined ? EXEMPT : options.reason;
  const rows = await sql<{ id: string }>`
    INSERT INTO app.payout_account_changes
      (app_id, user_id, old_payout_method, new_payout_method, old_hmac, new_hmac, operator,
       changed_at, created_at, limit_exempt_reason)
    VALUES (${f.appId}, ${f.uid}, 'alipay', 'alipay', ${randomBytes(32).toString('hex')}, '',
      ${OPERATOR}, ${at}, ${at}, ${reason})
    RETURNING id::text AS id`.execute(options.handle ?? kit.db);
  return rows.rows[0]!.id;
}

/** limit_exempt_reason of the subject's change rows, in id order. */
export async function exemptReasons(kit: Kit, f: Fixture) {
  const rows = await sql<{ reason: string | null }>`
    SELECT limit_exempt_reason AS reason FROM app.payout_account_changes
    WHERE app_id = ${f.appId} AND user_id = ${f.uid} ORDER BY id`.execute(kit.db);
  return rows.rows.map((row) => row.reason);
}

/** The caller's users row lock (B1-27g holds it before calling invalidate). */
export async function lockUser(trx: Transaction<DB>, f: Fixture) {
  const rows = await sql<{ id: string }>`
    SELECT id FROM app.users WHERE app_id = ${f.appId} AND id = ${f.uid} FOR UPDATE`.execute(trx);
  expect(rows.rows).toHaveLength(1);
}

/** The port, built in each test so NotImplemented is a test failure, not a hook failure. */
export async function invalidation() {
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Invalidation;
  return identity.createPayoutAccountInvalidation();
}

/** invalidate in its own transaction that first takes the users row lock. */
export async function invalidate(kit: Kit, f: Fixture, now: Date, operator = OPERATOR) {
  const port = await invalidation();
  return kit.db.transaction().execute(async (trx) => {
    await lockUser(trx, f);
    return port.invalidate(trx, { appId: f.appId, userId: f.uid, operator, now });
  });
}

/** SQLSTATE and constraint of a failed statement; null when it succeeded. */
export async function failure(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    const e = error as { code?: unknown; constraint?: unknown };
    return { code: e.code, constraint: e.constraint };
  }
}
