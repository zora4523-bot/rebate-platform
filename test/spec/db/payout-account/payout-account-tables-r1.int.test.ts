// Additions after the rule-test review round 1 of B1-13a (out-of-scope entries of the review;
// 规划/04 §3.2 payout_account_verify_attempts 部分唯一 (app_id, user_id, idempotency_key)
// WHERE idempotency_key IS NOT NULL; BR-WDR-02 细则「核验次数上限」「同一个键再次提交」;
// db/AGENTS.md #4; ADR-0001 §4.2 #8). Real PostgreSQL as the business roles.
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  PAYOUT_TABLES,
  PERMISSION_DENIED,
  UNIQUE_VIOLATION,
  freshValue,
  insertRow,
  newUser,
  sqlState,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let payout: Kysely<DB>;
let readonly: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
  useDb(app);
});

afterAll(async () => {
  await Promise.all([app, payout, readonly, maint].map((db) => destroyDb(db)));
  await database.drop();
});

const ATTEMPTS = 'payout_account_verify_attempts';

async function columnPrivilege(role: string, table: string, privilege: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }>`
    SELECT has_any_column_privilege(${role}, ${`app.${table}`}, ${privilege}) AS ok
  `.execute(app);
  return rows.rows[0]?.ok === true;
}

async function tablePrivilege(role: string, table: string, privilege: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }>`
    SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS ok
  `.execute(app);
  return rows.rows[0]?.ok === true;
}

it('[AC-B1-13a#33] couli_readonly, couli_payout and couli_maint hold no table-level or column-level write privilege on the three tables, and their writes are refused', async () => {
  for (const table of PAYOUT_TABLES) {
    for (const role of ['couli_readonly', 'couli_payout', 'couli_maint']) {
      for (const privilege of ['INSERT', 'UPDATE']) {
        expect(await tablePrivilege(role, table, privilege), `${role} ${table} ${privilege}`).toBe(
          false,
        );
        expect(
          await columnPrivilege(role, table, privilege),
          `${role} ${table} column ${privilege}`,
        ).toBe(false);
      }
      for (const privilege of ['DELETE', 'TRUNCATE']) {
        expect(await tablePrivilege(role, table, privilege), `${role} ${table} ${privilege}`).toBe(
          false,
        );
      }
    }
  }
  for (const [role, db] of [
    ['couli_readonly', readonly],
    ['couli_payout', payout],
    ['couli_maint', maint],
  ] as const) {
    expect(
      await sqlState(
        sql`UPDATE app.payout_accounts SET is_current = false WHERE false`.execute(db),
      ),
      `${role} payout_accounts`,
    ).toBe(PERMISSION_DENIED);
    expect(
      await sqlState(
        sql`UPDATE app.payout_account_verify_attempts SET status = 'released' WHERE false`.execute(
          db,
        ),
      ),
      `${role} ${ATTEMPTS}`,
    ).toBe(PERMISSION_DENIED);
    expect(
      await sqlState(
        sql`INSERT INTO app.payout_account_changes (app_id) SELECT 'couli' WHERE false`.execute(db),
      ),
      `${role} payout_account_changes`,
    ).toBe(PERMISSION_DENIED);
  }
});

it('[AC-B1-13a#34] an idempotency key reused on another day still binds one verification of the member (BR-WDR-02 细则「同一个键再次提交」: 不为同一个键新建核验记录)', async () => {
  const user = await newUser();
  const key = await freshValue(ATTEMPTS, 'idempotency_key');
  const base = {
    app_id: 'couli',
    user_id: user,
    status: 'expired_unresolved',
    origin_action: 'payout_account_change',
    idempotency_key: key,
  };
  await insertRow(ATTEMPTS, {
    ...base,
    verify_date: '2026-10-04',
    reserved_at: new Date('2026-10-04T08:00:00Z'),
    vendor_request_id: await freshValue(ATTEMPTS, 'vendor_request_id'),
    request_fingerprint: await freshValue(ATTEMPTS, 'request_fingerprint'),
  });
  expect(
    await sqlState(
      insertRow(ATTEMPTS, {
        ...base,
        status: 'reserved',
        verify_date: '2026-10-05',
        reserved_at: new Date('2026-10-05T01:00:00Z'),
        vendor_request_id: await freshValue(ATTEMPTS, 'vendor_request_id'),
        request_fingerprint: await freshValue(ATTEMPTS, 'request_fingerprint'),
      }),
    ),
  ).toBe(UNIQUE_VIOLATION);
  const rows = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.payout_account_verify_attempts
    WHERE app_id = 'couli' AND user_id = ${user} AND idempotency_key = ${key}
  `.execute(app);
  expect(rows.rows).toEqual([{ n: '1' }]);
});
