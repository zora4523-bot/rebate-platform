// B2-05j rule tests: payout_account_changes.limit_exempt_reason is null or realname_correction
// (04 §3.2), enforced by a validated CHECK (two-stage migration: NOT VALID, then VALIDATE; the
// migration numbers are not pinned), and the table stays append-only for couli_app. Real PG as the
// business role through the B1-13e kit. Top-level it() only.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { NOW, close, fixture, open, state, type Kit } from '../payout-account/kit.ts';
import { CHECK_NAME, EXEMPT, exemptChange, exemptColumn, exemptReasons, failure } from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => {
  kit.clock.set(NOW);
  kit.lines.length = 0;
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

const CHECK_VIOLATION = '23514';
const PERMISSION_DENIED = '42501';
const RESTRICT_VIOLATION = '23001';

it('[AC-B2-05j#8] limit_exempt_reason 只接受 null 与 realname_correction；其他值被已校验的 CHECK 拒绝', async () => {
  const f = await fixture(kit);
  await exemptColumn(kit);
  const checks = await sql<{ name: string; validated: boolean }>`
    SELECT conname AS name, convalidated AS validated FROM pg_constraint
    WHERE conrelid = 'app.payout_account_changes'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%limit_exempt_reason%'`.execute(kit.db);
  expect(checks.rows).toEqual([{ name: CHECK_NAME, validated: true }]);

  await exemptChange(kit, f, { reason: null });
  await exemptChange(kit, f, { reason: EXEMPT });
  const before = await state(kit, f);
  for (const reason of ['other', 'REALNAME_CORRECTION', 'realname_correction ', '']) {
    expect(await failure(exemptChange(kit, f, { reason })), JSON.stringify(reason)).toEqual({
      code: CHECK_VIOLATION,
      constraint: CHECK_NAME,
    });
  }
  expect(await state(kit, f)).toEqual(before);
  expect(await exemptReasons(kit, f)).toEqual([null, EXEMPT]);
});

it('[AC-B2-05j#9] 加列后表仍只追加：exempt 行的 UPDATE / DELETE 被拒，触发器仍启用，couli_app 无 UPDATE / DELETE 权限', async () => {
  const f = await fixture(kit);
  await exemptColumn(kit);
  const id = await exemptChange(kit, f);
  const before = await state(kit, f);
  const rejected = [PERMISSION_DENIED, RESTRICT_VIOLATION];
  const update = sql`UPDATE app.payout_account_changes SET limit_exempt_reason = NULL
    WHERE id = ${id}`;
  expect(rejected).toContain((await failure(update.execute(kit.db)))?.code);
  const remove = sql`DELETE FROM app.payout_account_changes WHERE id = ${id}`;
  expect(rejected).toContain((await failure(remove.execute(kit.db)))?.code);
  expect(await state(kit, f)).toEqual(before);
  expect(await exemptReasons(kit, f)).toEqual([EXEMPT]);

  const trigger = await sql<{ enabled: string; def: string }>`
    SELECT tgenabled AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgrelid = 'app.payout_account_changes'::regclass
      AND tgname = 'payout_account_changes_append_only'`.execute(kit.db);
  expect(trigger.rows).toHaveLength(1);
  expect(trigger.rows[0]!.enabled).toBe('O');
  expect(trigger.rows[0]!.def).toMatch(
    /BEFORE DELETE OR UPDATE .* FOR EACH ROW .*reject_update_delete\(\)/,
  );
  const privileges = await sql<Record<string, boolean>>`
    SELECT
      has_table_privilege('couli_app', 'app.payout_account_changes', 'UPDATE') AS can_update,
      has_table_privilege('couli_app', 'app.payout_account_changes', 'DELETE') AS can_delete,
      has_table_privilege('couli_app', 'app.payout_account_changes', 'TRUNCATE') AS can_truncate,
      has_column_privilege('couli_app', 'app.payout_account_changes', 'limit_exempt_reason',
        'UPDATE') AS can_update_column`.execute(kit.db);
  expect(privileges.rows).toEqual([
    { can_update: false, can_delete: false, can_truncate: false, can_update_column: false },
  ]);
});
