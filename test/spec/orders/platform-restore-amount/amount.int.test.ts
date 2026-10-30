// B1-08ze（编排 9.2 第 1 条、9.3）：P9（INVALID → PAID / RECEIVED / SETTLED）状态触发的 platform_restore 差错单，
// expected_fen = 本次更新之后的有效佣金（08 BR-CALC-02 取值阶段：结算佣金非空取结算佣金，否则取预估佣金；空按 0），
// actual_fen = 0，diff_fen = expected_fen。触发条件、前提、键、告警都不变。
// ① 拼多多形状（适配器结算佣金恒空）：INVALID → SETTLED、结算佣金空、预估 450 → expected_fen 450（不再记 0）。
// ② 回归：INVALID → SETTLED、结算佣金非空（600 / 0）、预估 450 → expected_fen 取结算佣金（600 / 0），不取预估。
// ③ 回归：INVALID → RECEIVED / PAID、结算佣金空、预估 300 → expected_fen 300。
// ②③ 在同一测试里各带一张 ① 形状的对照单，钉住「SETTLED 时结算佣金为空要退回预估」。
// 骗法：SETTLED 时仍只取结算佣金（空 → 0：①与②③的对照红）；一律取预估（②的 600 红）。
// 订单的前序状态（返利状态、原因、进入行）由 B1-08zc 的 kit 直接写入，代表 settlement 先前的处理。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  expectedKeys,
  expectNotRevived,
  expectP9Warn,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  SETTLED,
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

/** VOID(REFUND)，未收货退款失效（PLATFORM_INVALID 进入），平台 INVALID。 */
function voidRefund(est: bigint): RestoreSpec {
  return {
    rebate: 'VOID',
    reason: 'REFUND',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
    est,
  };
}

/** CLAWED_BACK、reason 为空（支 ii：仅凭 PLATFORM_INVALID 进入），收货后失效，平台 INVALID。 */
function clawedBackEntryOnly(est: bigint): RestoreSpec {
  return {
    rebate: 'CLAWED_BACK',
    reason: null,
    entry: { from: 'CREDITED', event: 'PLATFORM_INVALID', to: 'CLAWED_BACK' },
    imported: 'invalid_received',
    est,
  };
}

/** P9 到 SETTLED 的报文（收货与结算时间都给），结算佣金按 settle 给出（null：拼多多形状）。 */
function toSettled(settle: bigint | null): Report {
  return {
    raw_status: 'settled',
    received_at: at(RECEIVED),
    settled_at: at(SETTLED),
    settle_commission_fen: settle,
  };
}

/** P9 到 RECEIVED / PAID 的报文（结算佣金仍为空）。 */
function toActive(platform: 'RECEIVED' | 'PAID'): Report {
  return platform === 'RECEIVED'
    ? { raw_status: 'received', received_at: at(RECEIVED), settle_commission_fen: null }
    : { raw_status: 'paid', settle_commission_fen: null };
}

/** 本次 P9 报文写入后：平台状态与两列佣金如期，返利状态不变。 */
async function expectRow(
  f: Scenario,
  spec: RestoreSpec,
  platform: string,
  stored: { est: bigint; settle: bigint | null },
) {
  const row = await f.order();
  expect(row.platform_status).toBe(platform);
  expect(row.est_commission_fen).toBe(stored.est);
  expect(row.settle_commission_fen).toBe(stored.settle);
  await expectNotRevived(f, spec.rebate, spec.reason);
}

/** 恰好一张状态触发的 platform_restore 差错单，金额 expectedFen；一行恢复告警，P9 告警照旧。 */
async function expectStatusDiff(
  f: Scenario,
  spec: RestoreSpec,
  platform: string,
  expectedFen: bigint,
) {
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
      trigger: 'status',
      platform_status: platform,
    },
  });
  const warns = f.restoreWarns();
  expect(warns).toHaveLength(1);
  expect(warns[0]?.[0]).toMatchObject({
    alert: RESTORE_ALERT,
    recon_diff_id: diffs[0]?.id,
    trigger: 'status',
    reason_code: spec.reason,
  });
  expectP9Warn(f);
}

/** ① 拼多多形状：INVALID → SETTLED、结算佣金空、预估 450 → 一张 expected_fen = diff_fen = 450。 */
async function pddSettled(spec: RestoreSpec) {
  const f = await scenario(db, spec);
  expect(await f.sync(toSettled(null))).toMatchObject({ ok: true, value: { kind: 'updated' } });
  await expectRow(f, spec, 'SETTLED', { est: 450n, settle: null });
  await expectStatusDiff(f, spec, 'SETTLED', 450n);
}

it.each([
  { label: 'VOID(REFUND)', spec: voidRefund(450n) },
  { label: 'CLAWED_BACK（reason 空，PLATFORM_INVALID 进入）', spec: clawedBackEntryOnly(450n) },
])(
  '[AC-B1-08ze#1] $label：P9 INVALID → SETTLED、结算佣金为空（拼多多形状）、预估佣金 450 → 状态触发一张 expected_fen = diff_fen = 450，不记 0',
  async ({ spec }) => {
    await pddSettled(spec);
  },
);

it.each([
  { settle: 600n, label: '600' },
  { settle: 0n, label: '0' },
])(
  '[AC-B1-08ze#2] P9 INVALID → SETTLED、结算佣金非空 $label、预估佣金 450 → expected_fen 取结算佣金 $label，不取预估；对照的拼多多形状单取预估 450',
  async ({ settle }) => {
    const spec = voidRefund(450n);
    const f = await scenario(db, spec);
    expect(await f.sync(toSettled(settle))).toMatchObject({ ok: true, value: { kind: 'updated' } });
    await expectRow(f, spec, 'SETTLED', { est: 450n, settle });
    await expectStatusDiff(f, spec, 'SETTLED', settle);

    await pddSettled(voidRefund(450n));
  },
);

it.each([{ platform: 'RECEIVED' as const }, { platform: 'PAID' as const }])(
  '[AC-B1-08ze#3] P9 INVALID → $platform、结算佣金为空、预估佣金 300 → expected_fen 300；对照的拼多多形状单（→ SETTLED）取预估 450',
  async ({ platform }) => {
    const spec = voidRefund(300n);
    const f = await scenario(db, spec);
    expect(await f.sync(toActive(platform))).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    await expectRow(f, spec, platform, { est: 300n, settle: null });
    await expectStatusDiff(f, spec, platform, 300n);

    await pddSettled(clawedBackEntryOnly(450n));
  },
);
