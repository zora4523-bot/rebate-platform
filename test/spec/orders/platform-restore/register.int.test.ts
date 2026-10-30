// B1-08zc：作废 / 扣回子订单被平台恢复 → 告警并经 orders 声明的端口登记一张 platform_restore 差错单
// （08 BR-FUND-22 正文与细则例 R12 / R13；编排 9.2 第 2～5 条）。两种触发：P9（INVALID 回到 PAID / RECEIVED /
// SETTLED）与本次写入的佣金列由 ≤0 或空变为 >0；返利状态不变（不复活，处理只经 ADMIN_RESTORE）。
// 库内返利状态、原因与进入行由测试直接写，代表 settlement 先前的迁移；端口由真实 ledger registerReconDiffOnce 实现。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  expectedKeys,
  expectNotRevived,
  expectP9Warn,
  expectSafeLogs,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  type Report,
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

it('[AC-B1-08zc#4] 例 R12：VOID(REFUND) 收到「订单收货」（P9 → RECEIVED）→ 一张 platform_restore（R1、order 引用、当前中国月份）+ 一条告警，返利状态不变', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'REFUND',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
  });
  // 中国时间 2026-11-01 00:31，UTC 仍是 10 月：period 取中国时间月份。
  f.setClock('2026-10-31T16:30:00.000Z');
  const result = await f.sync({ raw_status: 'received', received_at: at(RECEIVED) });
  expect(result).toEqual({
    ok: true,
    value: { kind: 'updated', order_id: f.original.order_id },
  });

  const row = await f.order();
  expect(row.platform_status).toBe('RECEIVED');
  await expectNotRevived(f, 'VOID', 'REFUND');

  const { refId, dedupeKey } = expectedKeys(f);
  const resolution = {
    reason_code: 'REFUND',
    rebate_status: 'VOID',
    trigger: 'status',
    platform_status: 'RECEIVED',
  };
  expect(f.register).toHaveBeenCalledTimes(1);
  const [trx, input] = f.register.mock.calls[0]!;
  expect(trx.isTransaction).toBe(true);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(trx).toBe(f.onUpdated.mock.calls[0]?.[0]);
  expect(input).toEqual({
    appId: f.ctx.app_id,
    type: 'platform_restore',
    source: 'R1',
    period: '2026-11',
    refType: 'order',
    refId,
    expectedFen: 789n,
    actualFen: 0n,
    diffFen: 789n,
    dedupeKey,
    resolution,
  });

  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    app_id: f.ctx.app_id,
    type: 'platform_restore',
    source: 'R1',
    period: '2026-11',
    ref_type: 'order',
    ref_id: refId,
    expected_fen: 789n,
    actual_fen: 0n,
    diff_fen: 789n,
    status: 'open',
    handler_id: null,
    closed_at: null,
    dedupe_key: dedupeKey,
    resolution,
  });

  const warns = f.restoreWarns();
  expect(warns).toHaveLength(1);
  expect(warns[0]?.[0]).toMatchObject({
    alert: RESTORE_ALERT,
    app_id: f.ctx.app_id,
    order_id: f.original.order_id,
    recon_diff_id: diffs[0]?.id,
    trigger: 'status',
    reason_code: 'REFUND',
  });
  expect(warns[0]?.[1]).toEqual(expect.any(String));
  // B1-08i 的 P9 告警照旧。
  expectP9Warn(f);
  expectSafeLogs(f);
});

interface Case {
  readonly label: string;
  readonly spec: RestoreSpec;
  readonly change: Report;
  readonly trigger: 'status' | 'commission';
  readonly platformAfter: string;
  readonly expectedFen: bigint;
}

const CASES: readonly Case[] = [
  {
    label:
      '例 R13：CLAWED_BACK(REFUND)，结算后失效扣回（INVALID_AFTER_SETTLE），平台仍 SETTLED；结算佣金 0 → 1234',
    spec: {
      rebate: 'CLAWED_BACK',
      reason: 'REFUND',
      entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
      imported: 'settled',
      settle: 0n,
    },
    change: { settle_commission_fen: 1234n },
    trigger: 'commission',
    platformAfter: 'SETTLED',
    expectedFen: 1234n,
  },
  {
    label: 'CLAWED_BACK(REFUND)，收货后退款失效扣回（PLATFORM_INVALID）；P9 → RECEIVED',
    spec: {
      rebate: 'CLAWED_BACK',
      reason: 'REFUND',
      entry: { from: 'CREDITED', event: 'PLATFORM_INVALID', to: 'CLAWED_BACK' },
      imported: 'invalid_received',
    },
    change: { raw_status: 'received', received_at: at(RECEIVED) },
    trigger: 'status',
    platformAfter: 'RECEIVED',
    expectedFen: 789n,
  },
  {
    label: 'VOID(REFUND)；P9 → PAID',
    spec: {
      rebate: 'VOID',
      reason: 'REFUND',
      entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
      imported: 'invalid',
      est: 555n,
    },
    change: { raw_status: 'paid' },
    trigger: 'status',
    platformAfter: 'PAID',
    expectedFen: 555n,
  },
  {
    label: 'VOID(COMMISSION_ZERO)，基数为零作废（BASE_ZERO）；预估佣金 0 → 456',
    spec: {
      rebate: 'VOID',
      reason: 'COMMISSION_ZERO',
      entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
      imported: 'paid',
      est: 0n,
    },
    change: { est_commission_fen: 456n, commission_fen: 456n },
    trigger: 'commission',
    platformAfter: 'PAID',
    expectedFen: 456n,
  },
  {
    label: 'VOID(RIGHTS)，全额维权作废（RIGHTS_FULL）；预估佣金 空 → 300',
    spec: {
      rebate: 'VOID',
      reason: 'RIGHTS',
      entry: { from: 'ESTIMATED', event: 'RIGHTS_FULL', to: 'VOID' },
      imported: 'paid',
      est: null,
    },
    change: { est_commission_fen: 300n, commission_fen: 300n },
    trigger: 'commission',
    platformAfter: 'PAID',
    expectedFen: 300n,
  },
  {
    label:
      'CLAWED_BACK(COMMISSION_ZERO)，入账后佣金归零扣回（BASE_ZERO），平台 RECEIVED；预估佣金 -20 → 610',
    spec: {
      rebate: 'CLAWED_BACK',
      reason: 'COMMISSION_ZERO',
      entry: { from: 'CREDITED', event: 'BASE_ZERO', to: 'CLAWED_BACK' },
      imported: 'received',
      est: -20n,
    },
    change: { est_commission_fen: 610n, commission_fen: 610n },
    trigger: 'commission',
    platformAfter: 'RECEIVED',
    expectedFen: 610n,
  },
];

it.each(CASES)(
  '[AC-B1-08zc#5] 平台恢复登记一张单（金额 = 恢复后的联盟佣金，actual 0），返利状态不变：$label',
  async ({ spec, change, trigger, platformAfter, expectedFen }) => {
    const f = await scenario(db, spec);
    expect(await f.sync(change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
    expect((await f.order()).platform_status).toBe(platformAfter);
    await expectNotRevived(f, spec.rebate, spec.reason);

    const { refId, dedupeKey } = expectedKeys(f);
    const resolution = {
      reason_code: spec.reason,
      rebate_status: spec.rebate,
      trigger,
      platform_status: platformAfter,
    };
    const diffs = await f.diffs();
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      type: 'platform_restore',
      source: 'R1',
      period: '2026-10',
      ref_type: 'order',
      ref_id: refId,
      expected_fen: expectedFen,
      actual_fen: 0n,
      diff_fen: expectedFen,
      status: 'open',
      dedupe_key: dedupeKey,
      resolution,
    });
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.register.mock.calls[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);

    const warns = f.restoreWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[0]).toMatchObject({
      alert: RESTORE_ALERT,
      app_id: f.ctx.app_id,
      order_id: f.original.order_id,
      recon_diff_id: diffs[0]?.id,
      trigger,
      reason_code: spec.reason,
    });
    if (trigger === 'status') expectP9Warn(f);
    expectSafeLogs(f);
  },
);
