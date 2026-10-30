// B1-08zd 规则测试评审 r1 S1 补充、编排第 11 节更正：同一报文把订单由 RECEIVED / PAID 推进到 SETTLED 时，佣金触发
// 按本次更新前后的「有效佣金」判定（BR-FUND-22「佣金恢复为 >0」；BR-CALC-02：结算佣金非空取它，否则取预估佣金），
// 与 platform_status 是否 SETTLED 无关；expected_fen = 新的有效佣金：
// ① 结算佣金 0（非空）、预估佣金 0 → 300 → 有效佣金 0 → 0，不登记、不告警；之后结算佣金 0 → 500 才登记一张 500。
// ② 结算佣金为空、预估佣金 0 → 300 → 有效佣金 0 → 300，当次登记一张 expected_fen 300（trigger=commission、
//    platform SETTLED）；之后结算佣金空 → 0（有效佣金 300 → 0）、预估 300 → 0 → 450（结算佣金已非空）不再调用登记端口。
// ③ 结算佣金空 → 500（预估不变或 0 → 280）→ 当次登记一张 expected_fen 500（取结算佣金，不取预估 280）；
//    之后结算佣金不变、只有预估佣金变化，不再调用登记端口。
// 骗法：按平台状态切换（更新后 SETTLED 就不看预估：②红；更新前非 SETTLED 只看预估：③红）；结算佣金非空时
// 仍看预估（①、②后半红）。
// 订单的前序状态（返利状态、原因、进入行）由 B1-08zc 的 kit 直接写入，代表 settlement 先前的处理。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  at,
  expectedKeys,
  expectNoRestore,
  expectNotRevived,
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

/** VOID(RIGHTS)，平台 RECEIVED，全额维权后预估佣金 0，库内无结算佣金。 */
const RECEIVED_RIGHTS: RestoreSpec = {
  rebate: 'VOID',
  reason: 'RIGHTS',
  entry: { from: 'WAITING', event: 'RIGHTS_FULL', to: 'VOID' },
  imported: 'received',
  est: 0n,
};

/** VOID(COMMISSION_ZERO)，平台 PAID，预估佣金 0，库内无结算佣金。 */
const PAID_ZERO: RestoreSpec = {
  rebate: 'VOID',
  reason: 'COMMISSION_ZERO',
  entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
  imported: 'paid',
  est: 0n,
};

interface Origin {
  readonly platform: 'RECEIVED' | 'PAID';
  readonly spec: RestoreSpec;
}
const ORIGINS: readonly Origin[] = [
  { platform: 'RECEIVED', spec: RECEIVED_RIGHTS },
  { platform: 'PAID', spec: PAID_ZERO },
];

interface QuietCase extends Origin {
  readonly label: string;
  /** Settled commission the moving report carries (absent: none). */
  readonly settle: Report;
  /** settle_commission_fen stored after the move. */
  readonly stored: bigint | null;
}
const NOTHING: Report = {};
const SETTLE_ZERO: Report = { settle_commission_fen: 0n };
const EST_280: Report = { est_commission_fen: 280n };
const QUIET_CASES: readonly QuietCase[] = ORIGINS.map((origin): QuietCase => ({
  ...origin,
  label: '结算佣金 0',
  settle: SETTLE_ZERO,
  stored: 0n,
}));

interface RestoreCase extends Origin {
  readonly label: string;
  /** Estimated commission the moving report carries (absent: unchanged). */
  readonly est: Report;
  /** est_commission_fen stored after the move. */
  readonly storedEst: bigint;
}
const RESTORE_CASES: readonly RestoreCase[] = ORIGINS.flatMap((origin): RestoreCase[] => [
  { ...origin, label: '预估佣金不变（0）', est: NOTHING, storedEst: 0n },
  { ...origin, label: '预估佣金 0 → 280', est: EST_280, storedEst: 280n },
]);

/** 本次报文把平台推进到 SETTLED（P4 / P5；收货与结算时间都给，PAID 经 RECEIVED 两步）。 */
function toSettled(change: Report): Report {
  return {
    raw_status: 'settled',
    received_at: at(RECEIVED),
    settled_at: at(SETTLED),
    ...change,
  };
}

/** 推进前平台仍是 platform、结算佣金为空。 */
async function expectOrigin(f: Scenario, platform: string) {
  const row = await f.order();
  expect(row.platform_status).toBe(platform);
  expect(row.settle_commission_fen).toBeNull();
}

/** 本次报文写入后平台为 SETTLED，最后一条平台历史是本次的「→ SETTLED」。 */
async function expectSettledNow(f: Scenario, stored: { est: bigint; settle: bigint | null }) {
  const row = await f.order();
  expect(row.platform_status).toBe('SETTLED');
  expect(row.est_commission_fen).toBe(stored.est);
  expect(row.settle_commission_fen).toBe(stored.settle);
  const platformRows = (await f.history()).filter((h) => h.field === 'platform');
  expect(platformRows.at(-1)).toMatchObject({ event: 'PLATFORM_SETTLED', to_status: 'SETTLED' });
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

it.each(QUIET_CASES)(
  '[AC-B1-08zd#7] 平台 $platform → SETTLED 的同一报文、$label、预估佣金 0 → 300 → 不登记、不告警；之后结算佣金 → 500 才登记一张 expected_fen 500',
  async ({ platform, spec, settle, stored }) => {
    const f = await scenario(db, spec);
    await expectOrigin(f, platform);

    const moved = await f.sync(toSettled({ est_commission_fen: 300n, ...settle }));
    expect(moved).toMatchObject({ ok: true, value: { kind: 'updated' } });
    await expectSettledNow(f, { est: 300n, settle: stored });
    await expectNoRestore(f);
    await expectNotRevived(f, spec.rebate, spec.reason);

    const restored = await f.sync({ settle_commission_fen: 500n });
    expect(restored).toMatchObject({ ok: true, value: { kind: 'updated' } });
    const row = await f.order();
    expect(row.platform_status).toBe('SETTLED');
    expect(row.est_commission_fen).toBe(300n);
    expect(row.settle_commission_fen).toBe(500n);
    await expectOneSettledDiff(f, spec, 500n);
  },
);

it.each(ORIGINS)(
  '[AC-B1-08zd#7] 平台 $platform → SETTLED 的同一报文、结算佣金为空、预估佣金 0 → 300 → 有效佣金是预估佣金，当次登记一张 expected_fen 300（trigger=commission、platform SETTLED）；之后结算佣金空 → 0、预估 300 → 0 → 450 不再调用登记端口',
  async ({ platform, spec }) => {
    const f = await scenario(db, spec);
    await expectOrigin(f, platform);

    const moved = await f.sync(toSettled({ est_commission_fen: 300n }));
    expect(moved).toMatchObject({ ok: true, value: { kind: 'updated' } });
    await expectSettledNow(f, { est: 300n, settle: null });
    await expectOneSettledDiff(f, spec, 300n);

    // 结算佣金空 → 0：有效佣金 300 → 0，不触发；之后结算佣金非空，预估 300 → 0 → 450 只存档，不触发。
    const diffs = await f.diffs();
    const steps: readonly { change: Report; est: bigint }[] = [
      { change: SETTLE_ZERO, est: 300n },
      { change: { est_commission_fen: 0n }, est: 0n },
      { change: { est_commission_fen: 450n }, est: 450n },
    ];
    for (const step of steps) {
      expect(await f.sync(step.change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
      const row = await f.order();
      expect(row.platform_status).toBe('SETTLED');
      expect(row.est_commission_fen).toBe(step.est);
      expect(row.settle_commission_fen).toBe(0n);
      expect(f.register).toHaveBeenCalledTimes(1);
      expect(await f.diffs()).toEqual(diffs);
      expect(f.restoreWarns()).toHaveLength(1);
    }
    await expectOneSettledDiff(f, spec, 300n);
  },
);

it.each(RESTORE_CASES)(
  '[AC-B1-08zd#8] 平台 $platform → SETTLED 的同一报文、结算佣金空 → 500、$label → 当次登记一张 expected_fen 500；之后只有预估佣金变化不再调用登记端口',
  async ({ platform, spec, est, storedEst }) => {
    const f = await scenario(db, spec);
    await expectOrigin(f, platform);

    const moved = await f.sync(toSettled({ settle_commission_fen: 500n, ...est }));
    expect(moved).toMatchObject({ ok: true, value: { kind: 'updated' } });
    await expectSettledNow(f, { est: storedEst, settle: 500n });
    await expectOneSettledDiff(f, spec, 500n);

    // 平台已 SETTLED、结算佣金不变：预估佣金 → 300 → 0 → 450（每次都是实际变化）不触发，
    // 同一进入行也不会因预估变化再登记。
    for (const next of [300n, 0n, 450n]) {
      expect(await f.sync({ est_commission_fen: next })).toMatchObject({
        ok: true,
        value: { kind: 'updated' },
      });
    }
    const row = await f.order();
    expect(row.platform_status).toBe('SETTLED');
    expect(row.est_commission_fen).toBe(450n);
    expect(row.settle_commission_fen).toBe(500n);
    await expectOneSettledDiff(f, spec, 500n);
  },
);
