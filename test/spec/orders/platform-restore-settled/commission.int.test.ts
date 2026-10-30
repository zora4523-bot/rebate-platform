// B1-08zd：平台已结算（platform_status = SETTLED）时的佣金触发按「有效佣金」判定（08 BR-FUND-22「佣金恢复为 >0」；
// BR-CALC-02 取值阶段：settle_commission_fen 为空时取最新预估收入，一旦非空只取结算收入、之后预估的变化只存档；
// 编排第 11 节更正 9.2 第 1 条）。有效佣金 = 结算佣金非空时取它，否则取预估佣金；本次更新使有效佣金由 ≤0 / 空
// 变为 >0 才触发，expected_fen = 新的有效佣金。
// ① 结算佣金为 0（非空）、只有预估佣金由 0 变 >0 → 订单并未被恢复：不登记、不告警
//    （B1-08zc money r1 S2 的原场景，CLAWED_BACK(COMMISSION_ZERO) 与 VOID(REFUND) 各一例）。
// ② 结算佣金为空（如拼多多，适配器恒不给结算佣金）、预估佣金 0 → >0 → 照常登记，expected_fen = 新预估佣金；
//    之后结算佣金空 → 0（有效佣金 >0 → 0）、结算佣金非空时预估的变化、预估 >0 → 另一 >0 都不触发。
// ③ 结算佣金由 0 / 空变 >0（预估佣金怎么变都行）→ 照常登记，expected_fen = 新结算佣金。
// 骗法：仍按 platform_status 切换、结算佣金为空时也不看预估（②红）；结算佣金非空时仍看预估（①、②后半红）；
// SETTLED 时两列都不看（③红）。
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

const UPDATED = { ok: true, value: { kind: 'updated' } } as const;

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

/**
 * One later report, after the one diff is registered, that is applied as usual and triggers nothing:
 * the port is not called again, the diff stays as first registered, still one restore warn.
 */
async function stillOneStep(
  f: Scenario,
  change: Report,
  stored: { est: bigint; settle: bigint | null },
  diffs: Awaited<ReturnType<Scenario['diffs']>>,
) {
  expect(await f.sync(change)).toMatchObject(UPDATED);
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(stored.est);
  expect(row.settle_commission_fen).toBe(stored.settle);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(await f.diffs()).toEqual(diffs);
  expect(f.restoreWarns()).toHaveLength(1);
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

/** CLAWED_BACK(COMMISSION_ZERO)：入账后有效佣金的正数部分变 0 被扣回，平台一直 SETTLED，预估佣金也为 0。 */
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

/** VOID(REFUND)：平台已 SETTLED、结算佣金为空的作废单（不给结算佣金的联盟），预估佣金为 0。 */
const VOID_REFUND_SETTLED_NO_SETTLE: RestoreSpec = { ...VOID_REFUND_SETTLED, settle: null };

it.each([
  { label: 'CLAWED_BACK(COMMISSION_ZERO)，结算佣金 0', spec: clawedBackZero(0n) },
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

it.each([
  { label: 'CLAWED_BACK(COMMISSION_ZERO)', spec: clawedBackZero(null) },
  { label: 'VOID(REFUND)', spec: VOID_REFUND_SETTLED_NO_SETTLE },
])(
  '[AC-B1-08zd#1] 平台 SETTLED、$label、结算佣金为空：预估佣金 0 → 300 → 有效佣金是预估佣金，登记一张 expected_fen 300；之后结算佣金空 → 0、预估 300 → 0 → 450（结算佣金已非空）都不再调用登记端口',
  async ({ spec }) => {
    const f = await scenario(db, spec);
    expect((await f.order()).settle_commission_fen).toBeNull();

    expect(await f.sync({ est_commission_fen: 300n })).toMatchObject(UPDATED);
    const row = await f.order();
    expect(row.platform_status).toBe('SETTLED');
    expect(row.est_commission_fen).toBe(300n);
    expect(row.settle_commission_fen).toBeNull();
    await expectOneSettledDiff(f, spec, 300n);

    const diffs = await f.diffs();
    await stillOneStep(f, { settle_commission_fen: 0n }, { est: 300n, settle: 0n }, diffs);
    await stillOneStep(f, { est_commission_fen: 0n }, { est: 0n, settle: 0n }, diffs);
    await stillOneStep(f, { est_commission_fen: 450n }, { est: 450n, settle: 0n }, diffs);
    await expectOneSettledDiff(f, spec, 300n);
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

it('[AC-B1-08zd#3] 平台 SETTLED、CLAWED_BACK 经 INVALID_AFTER_SETTLE 进入（reason 为空）、结算佣金为空、预估佣金 300：预估 300 → 450（未越过 0）、450 → 0 安静；预估 0 → 300 登记一张 expected_fen 300；之后结算佣金空 → 0（有效佣金 300 → 0）、预估 300 → 0 → 280 都不再调用登记端口', async () => {
  const spec: RestoreSpec = {
    rebate: 'CLAWED_BACK',
    reason: null,
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    est: 300n,
    settle: null,
  };
  const f = await scenario(db, spec);
  expect((await f.order()).est_commission_fen).toBe(300n);
  await quietStep(f, { est_commission_fen: 450n }, { est: 450n, settle: null });
  await quietStep(f, { est_commission_fen: 0n }, { est: 0n, settle: null });

  expect(await f.sync({ est_commission_fen: 300n })).toMatchObject(UPDATED);
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(300n);
  expect(row.settle_commission_fen).toBeNull();
  await expectOneSettledDiff(f, spec, 300n);

  const diffs = await f.diffs();
  await stillOneStep(f, { settle_commission_fen: 0n }, { est: 300n, settle: 0n }, diffs);
  await stillOneStep(f, { est_commission_fen: 0n }, { est: 0n, settle: 0n }, diffs);
  await stillOneStep(f, { est_commission_fen: 280n }, { est: 280n, settle: 0n }, diffs);
  await expectOneSettledDiff(f, spec, 300n);
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
