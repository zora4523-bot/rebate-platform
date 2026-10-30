// B1-08zd 回归（编排 9.2 第 1、2 条）：只有更新后 platform_status = SETTLED 时佣金触发才改看结算佣金。
// ① 非 SETTLED（PAID / RECEIVED）时预估佣金由 0 变 >0 照常登记，expected_fen = 新预估佣金；同一测试里对照一张
//    平台 SETTLED、结算佣金 0 的单，同样的预估变化不登记——钉住「按平台状态分流」，而不是一律看或一律不看预估。
// ② 状态触发（P9：INVALID → SETTLED）不受影响：照常出一张 trigger=status、金额取结算佣金的单；之后结算佣金不变、
//    只有预估佣金 0 → 300 时不再调用登记端口（同一进入行不会因预估变化再登记一次）。
// 骗法：一律只看结算佣金（①红）；SETTLED 时预估仍触发（①对照与②红）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  expectedKeys,
  expectNoRestore,
  expectNotRevived,
  expectP9Warn,
  RECEIVED,
  RESTORE_ALERT,
  scenario,
  SETTLED,
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

/** Exactly one platform_restore diff and its one warn line. */
async function expectOneDiff(
  f: Scenario,
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

/** 对照单：CLAWED_BACK(COMMISSION_ZERO)，平台 SETTLED、结算佣金 0；预估 0 → 300 不登记。 */
async function settledControl() {
  const spec: RestoreSpec = {
    rebate: 'CLAWED_BACK',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'CREDITED', event: 'COMMISSION_POSITIVE_ZERO', to: 'CLAWED_BACK' },
    imported: 'settled',
    est: 0n,
    settle: 0n,
  };
  const f = await scenario(db, spec);
  expect(await f.sync({ est_commission_fen: 300n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(300n);
  expect(row.settle_commission_fen).toBe(0n);
  await expectNoRestore(f);
  await expectNotRevived(f, spec.rebate, spec.reason);
}

/** VOID(COMMISSION_ZERO)，平台 PAID，预估佣金 0。 */
const PAID_ZERO: RestoreSpec = {
  rebate: 'VOID',
  reason: 'COMMISSION_ZERO',
  entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
  imported: 'paid',
  est: 0n,
};

/** VOID(RIGHTS)，平台 RECEIVED，全额维权后预估佣金 0。 */
const RECEIVED_RIGHTS: RestoreSpec = {
  rebate: 'VOID',
  reason: 'RIGHTS',
  entry: { from: 'WAITING', event: 'RIGHTS_FULL', to: 'VOID' },
  imported: 'received',
  est: 0n,
};

it.each([
  { platform: 'PAID', spec: PAID_ZERO },
  { platform: 'RECEIVED', spec: RECEIVED_RIGHTS },
])(
  '[AC-B1-08zd#5] 平台 $platform：预估佣金 0 → 300 照常登记一张 expected_fen 300（trigger=commission）；对照的 SETTLED、结算佣金 0 的单同样变化不登记',
  async ({ platform, spec }) => {
    const f = await scenario(db, spec);
    expect(await f.sync({ est_commission_fen: 300n, commission_fen: 300n })).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    const row = await f.order();
    expect(row.platform_status).toBe(platform);
    expect(row.est_commission_fen).toBe(300n);
    expect(row.settle_commission_fen).toBeNull();
    await expectOneDiff(f, spec, 'commission', platform, 300n);

    await settledControl();
  },
);

it('[AC-B1-08zd#6] P9 到 SETTLED 不受影响：VOID(REFUND) 由 INVALID 直接结算、结算佣金 450 → 状态触发一张 expected_fen 450；之后只有预估佣金 0 → 300 不再调用登记端口', async () => {
  const spec: RestoreSpec = {
    rebate: 'VOID',
    reason: 'REFUND',
    entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'invalid',
    est: 0n,
  };
  const f = await scenario(db, spec);
  const p9 = await f.sync({
    raw_status: 'settled',
    received_at: at(RECEIVED),
    settled_at: at(SETTLED),
    settle_commission_fen: 450n,
  });
  expect(p9).toMatchObject({ ok: true, value: { kind: 'updated' } });
  const settled = await f.order();
  expect(settled.platform_status).toBe('SETTLED');
  expect(settled.est_commission_fen).toBe(0n);
  expect(settled.settle_commission_fen).toBe(450n);
  await expectOneDiff(f, spec, 'status', 'SETTLED', 450n);
  expectP9Warn(f);
  expect(f.register).toHaveBeenCalledTimes(1);

  expect(await f.sync({ est_commission_fen: 300n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(300n);
  expect(row.settle_commission_fen).toBe(450n);
  expect(f.register).toHaveBeenCalledTimes(1);
  await expectOneDiff(f, spec, 'status', 'SETTLED', 450n);
});
