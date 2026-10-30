// B1-08zc（评审 r1 S1 第 2 条、S2 第 4 条）：
// ① 佣金触发的边界是「新值 >0」：由空或 ≤0 变为恰好 0 不是平台恢复，不登记、不告警；变为 1 分就登记。
//    骗法：用 >= 0 判新值（空 → 0、-10 → 0 会给运营一张 expected_fen 0 的假单）。
// ② 状态触发含 INVALID → SETTLED（P9 第三个去向）：结算佣金为 0 或空时也出单，trigger 为 status，
//    金额按 SETTLED 取结算佣金（编排 9.2 第 4 条：SETTLED 用 settle、否则 est，空按 0），不取预估佣金。
//    骗法：P9 只认 PAID / RECEIVED；SETTLED 时仍取 est。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  entryOf,
  expectNoRestore,
  expectNotRevived,
  expectP9Warn,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  SETTLED,
  type Report,
  type Scenario,
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

/** The hand-written keys of 编排 9.2 第 3 条. */
function keys(f: Scenario) {
  const entryId = entryOf(f).toString(10);
  return {
    ref_id: `${f.key}#RESTORE#${entryId}`,
    dedupe_key: `platform_restore:${f.key}:${entryId}`,
  };
}

/** One quiet report: applied to the column as usual, no diff, no port call, no restore warn. */
async function quietStep(
  f: Scenario,
  change: Report,
  column: 'est_commission_fen' | 'settle_commission_fen',
  value: bigint,
) {
  expect(await f.sync(change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
  expect((await f.order())[column]).toBe(value);
  await expectNoRestore(f);
}

it('[AC-B1-08zc#24] 预估佣金由空或 ≤0 变为恰好 0 不登记：VOID(RIGHTS) 空 → 0 → -10 → 0 都安静，0 → 1 分登记一张 expected_fen 1', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'RIGHTS',
    entry: { from: 'ESTIMATED', event: 'RIGHTS_FULL', to: 'VOID' },
    imported: 'paid',
    est: null,
  });
  expect((await f.order()).est_commission_fen).toBeNull();
  for (const est of [0n, -10n, 0n]) {
    await quietStep(f, { est_commission_fen: est, commission_fen: est }, 'est_commission_fen', est);
  }
  expect(await f.sync({ est_commission_fen: 1n, commission_fen: 1n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'platform_restore',
    ...keys(f),
    expected_fen: 1n,
    actual_fen: 0n,
    diff_fen: 1n,
    resolution: {
      reason_code: 'RIGHTS',
      rebate_status: 'VOID',
      trigger: 'commission',
      platform_status: 'PAID',
    },
  });
  expect(f.restoreWarns()).toHaveLength(1);
  await expectNotRevived(f, 'VOID', 'RIGHTS');
});

it('[AC-B1-08zc#24] 预估佣金 -20 → 0 不登记：VOID(COMMISSION_ZERO) 平台 RECEIVED，之后 0 → 1 分才登记', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
    imported: 'received',
    est: -20n,
  });
  await quietStep(f, { est_commission_fen: 0n, commission_fen: 0n }, 'est_commission_fen', 0n);
  expect(await f.sync({ est_commission_fen: 1n, commission_fen: 1n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    ...keys(f),
    expected_fen: 1n,
    diff_fen: 1n,
    resolution: { trigger: 'commission', platform_status: 'RECEIVED' },
  });
  expect(f.restoreWarns()).toHaveLength(1);
});

it('[AC-B1-08zc#25] 结算佣金同理：CLAWED_BACK(REFUND) 平台一直 SETTLED，结算佣金空 → 0 不登记，0 → 1 分登记一张 expected_fen 1', async () => {
  const f = await scenario(db, {
    rebate: 'CLAWED_BACK',
    reason: 'REFUND',
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    settle: null,
  });
  expect((await f.order()).settle_commission_fen).toBeNull();
  await quietStep(f, { settle_commission_fen: 0n }, 'settle_commission_fen', 0n);
  expect(await f.sync({ settle_commission_fen: 1n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect((await f.order()).platform_status).toBe('SETTLED');
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    ...keys(f),
    expected_fen: 1n,
    diff_fen: 1n,
    resolution: {
      reason_code: 'REFUND',
      rebate_status: 'CLAWED_BACK',
      trigger: 'commission',
      platform_status: 'SETTLED',
    },
  });
  expect(f.restoreWarns()).toHaveLength(1);
  await expectNotRevived(f, 'CLAWED_BACK', 'REFUND');
});

it.each([{ settle: 0n as bigint | null, label: '0' }])(
  '[AC-B1-08zc#26] P9 去向 SETTLED：VOID(REFUND) 由 INVALID 直接结算、结算佣金为 $label → 状态触发出一张单，金额按结算佣金（0），不取预估佣金 789',
  async ({ settle }) => {
    const f = await scenario(db, {
      rebate: 'VOID',
      reason: 'REFUND',
      entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
      imported: 'invalid',
      est: 789n,
    });
    expect(
      await f.sync({
        raw_status: 'settled',
        received_at: at(RECEIVED),
        settled_at: at(SETTLED),
        settle_commission_fen: settle,
      }),
    ).toMatchObject({ ok: true, value: { kind: 'updated' } });
    const row = await f.order();
    expect(row.platform_status).toBe('SETTLED');
    expect(row.est_commission_fen).toBe(789n);
    expect(row.settle_commission_fen).toBe(settle);
    await expectNotRevived(f, 'VOID', 'REFUND');

    const diffs = await f.diffs();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      type: 'platform_restore',
      source: 'R1',
      ref_type: 'order',
      ...keys(f),
      expected_fen: 0n,
      actual_fen: 0n,
      diff_fen: 0n,
      status: 'open',
      resolution: {
        reason_code: 'REFUND',
        rebate_status: 'VOID',
        trigger: 'status',
        platform_status: 'SETTLED',
      },
    });
    const warns = f.restoreWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[0]).toMatchObject({
      alert: RESTORE_ALERT,
      recon_diff_id: diffs[0]?.id,
      trigger: 'status',
      reason_code: 'REFUND',
    });
    expectP9Warn(f);
  },
);

it('[AC-B1-08zc#26] P9 去向 SETTLED：VOID(REFUND) 由 INVALID 直接结算、结算佣金为 空 → 状态触发出一张单，金额按结算佣金（0），不取预估佣金 789', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'REFUND',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
    est: 789n,
  });
  expect(
    await f.sync({
      raw_status: 'settled',
      received_at: at(RECEIVED),
      settled_at: at(SETTLED),
      settle_commission_fen: null,
    }),
  ).toMatchObject({ ok: true, value: { kind: 'updated' } });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(789n);
  expect(row.settle_commission_fen).toBe(null);
  await expectNotRevived(f, 'VOID', 'REFUND');

  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'platform_restore',
    source: 'R1',
    ref_type: 'order',
    ...keys(f),
    expected_fen: 789n,
    actual_fen: 0n,
    diff_fen: 789n,
    status: 'open',
    resolution: {
      reason_code: 'REFUND',
      rebate_status: 'VOID',
      trigger: 'status',
      platform_status: 'SETTLED',
    },
  });
  const warns = f.restoreWarns();
  expect(warns).toHaveLength(1);
  expect(warns[0]?.[0]).toMatchObject({
    alert: RESTORE_ALERT,
    recon_diff_id: diffs[0]?.id,
    trigger: 'status',
    reason_code: 'REFUND',
  });
  expectP9Warn(f);
});
