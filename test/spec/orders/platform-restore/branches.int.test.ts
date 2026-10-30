// B1-08zc：BR-FUND-22 的两支前提各钉一例（编排 06:13 核定）：
//   (i)  orders.reason ∈ {REFUND, RIGHTS, COMMISSION_ZERO}——进入事件不在 (ii) 集合内也出单；
//   (ii) 进入当前返利状态的那条 rebate 历史事件 ∈ {PLATFORM_INVALID, INVALID_AFTER_SETTLE}——reason 不在 (i) 集合内也出单。
// 骗法：只看 reason（漏 (ii)）、只看进入事件（漏 (i)）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  expectedKeys,
  expectNotRevived,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  type RestoreSpec,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function expectOneDiff(
  f: Awaited<ReturnType<typeof scenario>>,
  spec: RestoreSpec,
  trigger: 'status' | 'commission',
  platformAfter: string,
  expectedFen: bigint,
) {
  await expectNotRevived(f, spec.rebate, spec.reason);
  const { refId, dedupeKey } = expectedKeys(f);
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'platform_restore',
    source: 'R1',
    ref_type: 'order',
    ref_id: refId,
    dedupe_key: dedupeKey,
    expected_fen: expectedFen,
    actual_fen: 0n,
    diff_fen: expectedFen,
    status: 'open',
    resolution: {
      reason_code: spec.reason,
      rebate_status: spec.rebate,
      trigger,
      platform_status: platformAfter,
    },
  });
  const warns = f.restoreWarns();
  expect(warns).toHaveLength(1);
  expect(warns[0]?.[0]).toMatchObject({
    alert: RESTORE_ALERT,
    recon_diff_id: diffs[0]?.id,
    trigger,
    reason_code: spec.reason,
  });
}

it('[AC-B1-08zc#6] 支 (i) 仅凭 reason：VOID(RIGHTS)，进入事件 RIGHTS_FULL（不在 (ii) 集合）；P9 → RECEIVED 出单', async () => {
  const spec: RestoreSpec = {
    rebate: 'VOID',
    reason: 'RIGHTS',
    entry: { from: 'ESTIMATED', event: 'RIGHTS_FULL', to: 'VOID' },
    imported: 'invalid',
  };
  const f = await scenario(db, spec);
  expect(await f.sync({ raw_status: 'received', received_at: at(RECEIVED) })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  await expectOneDiff(f, spec, 'status', 'RECEIVED', 789n);
});

it('[AC-B1-08zc#7] 支 (i) 仅凭 reason：VOID(COMMISSION_ZERO)，进入事件 BASE_ZERO（不在 (ii) 集合）；佣金 0 → 88 出单', async () => {
  const spec: RestoreSpec = {
    rebate: 'VOID',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
    imported: 'paid',
    est: 0n,
  };
  const f = await scenario(db, spec);
  expect(await f.sync({ est_commission_fen: 88n, commission_fen: 88n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  await expectOneDiff(f, spec, 'commission', 'PAID', 88n);
});

it('[AC-B1-08zc#8] 支 (ii) 仅凭进入事件：VOID 经 PLATFORM_INVALID 进入、reason=OTHER（不在 (i) 集合）；P9 → PAID 出单', async () => {
  const spec: RestoreSpec = {
    rebate: 'VOID',
    reason: 'OTHER',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
    est: 321n,
  };
  const f = await scenario(db, spec);
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  await expectOneDiff(f, spec, 'status', 'PAID', 321n);
});

it('[AC-B1-08zc#9] 支 (ii) 仅凭进入事件：CLAWED_BACK 经 INVALID_AFTER_SETTLE 进入、reason 为空，平台仍 SETTLED；结算佣金 0 → 900 出单', async () => {
  const spec: RestoreSpec = {
    rebate: 'CLAWED_BACK',
    reason: null,
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    settle: 0n,
  };
  const f = await scenario(db, spec);
  expect(await f.sync({ settle_commission_fen: 900n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  await expectOneDiff(f, spec, 'commission', 'SETTLED', 900n);
});
