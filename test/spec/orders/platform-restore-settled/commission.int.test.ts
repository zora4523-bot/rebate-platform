// B1-08zd：平台已结算（更新后 platform_status = SETTLED）时，佣金触发只看结算佣金（08 BR-FUND-22「佣金恢复为 >0」；
// 结算后有效佣金是结算佣金，BR-FUND-01；编排 9.2 第 1 条）。
// ① 结算佣金仍为 0 或空、只有预估佣金由 0 变 >0（R9b 类的预估变化）→ 订单并未被恢复：不登记、不告警
//    （B1-08zc money r1 S2 的原场景，CLAWED_BACK(COMMISSION_ZERO) 与 VOID(REFUND) 各一例）。
// ② 结算佣金由 0 / 空变 >0（预估佣金怎么变都行）→ 照常登记，expected_fen = 新结算佣金。
// 骗法：SETTLED 时仍看预估佣金（①红）；SETTLED 时两列都不看（②红）。
// 订单的前序状态（返利状态、原因、进入行、库内结算佣金）由 B1-08zc 的 kit 直接写入，代表 settlement 先前的处理。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  expectedKeys,
  expectNoRestore,
  expectNotRevived,
  RESTORE_ALERT,
  scenario,
  type Report,
  type RestoreSpec,
  type Scenario,
} from '../platform-restore/kit.ts';

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

/** One later report that is applied as usual and registers nothing (no port call, no diff, no restore warn). */
async function quietStep(
  f: Scenario,
  change: Report,
  stored: { est: bigint; settle: bigint | null },
) {
  expect(await f.sync(change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(stored.est);
  expect(row.settle_commission_fen).toBe(stored.settle);
  await expectNoRestore(f);
}

/** Exactly one platform_restore diff (commission trigger, platform SETTLED) and its one warn line. */
async function expectOneSettledDiff(f: Scenario, spec: RestoreSpec, expectedFen: bigint) {
  await expectNotRevived(f, spec.rebate, spec.reason);
  const { refId, dedupeKey } = expectedKeys(f);
  expect(f.register).toHaveBeenCalledTimes(1);
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
      trigger: 'commission',
      platform_status: 'SETTLED',
    },
  });
  const warns = f.restoreWarns();
  expect(warns).toHaveLength(1);
  expect(warns[0]?.[0]).toMatchObject({
    alert: RESTORE_ALERT,
    recon_diff_id: diffs[0]?.id,
    trigger: 'commission',
    reason_code: spec.reason,
  });
}

/** CLAWED_BACK(COMMISSION_ZERO)：入账后结算佣金的正数部分变 0 被扣回，平台一直 SETTLED，预估佣金也为 0。 */
function clawedBackZero(settle: bigint | null): RestoreSpec {
  return {
    rebate: 'CLAWED_BACK',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'CREDITED', event: 'COMMISSION_POSITIVE_ZERO', to: 'CLAWED_BACK' },
    imported: 'settled',
    est: 0n,
    settle,
  };
}

/** VOID(REFUND)：平台已 SETTLED、结算佣金 0 的作废单，预估佣金为 0。 */
const VOID_REFUND_SETTLED: RestoreSpec = {
  rebate: 'VOID',
  reason: 'REFUND',
  entry: { from: 'WAITING', event: 'PLATFORM_INVALID', to: 'VOID' },
  imported: 'settled',
  est: 0n,
  settle: 0n,
};

it.each([
  { label: 'CLAWED_BACK(COMMISSION_ZERO)，结算佣金 0', spec: clawedBackZero(0n) },
  { label: 'CLAWED_BACK(COMMISSION_ZERO)，结算佣金为空', spec: clawedBackZero(null) },
  { label: 'VOID(REFUND)，结算佣金 0', spec: VOID_REFUND_SETTLED },
])(
  '[AC-B1-08zd#1] 平台 SETTLED、$label：只有预估佣金 0 → 300（结算佣金不变）→ 预估照常写入，不登记差错单、不打 platform_restore 告警',
  async ({ spec }) => {
    const f = await scenario(db, spec);
    const settle = spec.settle ?? null;
    expect((await f.order()).settle_commission_fen).toBe(settle);
    await quietStep(f, { est_commission_fen: 300n }, { est: 300n, settle });
    await expectNotRevived(f, spec.rebate, spec.reason);
  },
);

it('[AC-B1-08zd#2] 平台 SETTLED、CLAWED_BACK(COMMISSION_ZERO)：预估佣金反复 0 → 300 → 0 → 450 都安静；结算佣金之后 0 → 500 才登记一张 expected_fen 500', async () => {
  const spec = clawedBackZero(0n);
  const f = await scenario(db, spec);
  await quietStep(f, { est_commission_fen: 300n }, { est: 300n, settle: 0n });
  await quietStep(f, { est_commission_fen: 0n }, { est: 0n, settle: 0n });
  await quietStep(f, { est_commission_fen: 450n }, { est: 450n, settle: 0n });

  expect(await f.sync({ settle_commission_fen: 500n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(450n);
  expect(row.settle_commission_fen).toBe(500n);
  await expectOneSettledDiff(f, spec, 500n);
});

it('[AC-B1-08zd#3] 平台 SETTLED、CLAWED_BACK 经 INVALID_AFTER_SETTLE 进入（reason 为空）：预估 0 → 300 → 0 安静；同一报文预估 0 → 280、结算佣金空 → 520 → 登记一张，金额取结算佣金 520', async () => {
  const spec: RestoreSpec = {
    rebate: 'CLAWED_BACK',
    reason: null,
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    est: 0n,
    settle: null,
  };
  const f = await scenario(db, spec);
  await quietStep(f, { est_commission_fen: 300n }, { est: 300n, settle: null });
  await quietStep(f, { est_commission_fen: 0n }, { est: 0n, settle: null });

  const both = await f.sync({ est_commission_fen: 280n, settle_commission_fen: 520n });
  expect(both).toMatchObject({ ok: true, value: { kind: 'updated' } });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(280n);
  expect(row.settle_commission_fen).toBe(520n);
  await expectOneSettledDiff(f, spec, 520n);
});

it('[AC-B1-08zd#4] 平台 SETTLED、VOID(REFUND)：预估 0 → 300 安静；结算佣金 0 → 1 分登记一张 expected_fen 1（边界仍是新值 >0）', async () => {
  const f = await scenario(db, VOID_REFUND_SETTLED);
  await quietStep(f, { est_commission_fen: 300n }, { est: 300n, settle: 0n });

  expect(await f.sync({ settle_commission_fen: 1n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect((await f.order()).settle_commission_fen).toBe(1n);
  await expectOneSettledDiff(f, VOID_REFUND_SETTLED, 1n);
});
