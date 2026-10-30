// B1-08zc：不登记的情形（08 BR-FUND-22「因 PUNISH、BLACKLIST_HIT 作废的订单，platform_status 照常更新，不告警、
// 不生成差错单」；编排 9.2 第 2 条前提与触发）。每条都在同一测试里跑一个会出单的对照，证明检测确实在工作。
// 骗法：只按 reason 判、不看触发；看任意一条历史而非进入当前状态的那条；非 VOID / CLAWED_BACK 也登记；
// 佣金只要变化就登记（而不是由 ≤0 或空变为 >0）。
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
  scenario,
  type RebateStatus,
  type RebateStep,
  type Report,
  type RestoreSpec,
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

/** p9: INVALID → RECEIVED；est: 预估佣金 0 → 500（平台 PAID）；settle: 结算佣金 0 → 1234（平台 SETTLED）。 */
type Trigger = 'p9' | 'est' | 'settle';

const CHANGE = {
  p9: { raw_status: 'received', received_at: at(RECEIVED) },
  est: { est_commission_fen: 500n, commission_fen: 500n },
  settle: { settle_commission_fen: 1234n },
} as const;

function importedFor(trigger: Trigger): Pick<RestoreSpec, 'imported' | 'est' | 'settle'> {
  switch (trigger) {
    case 'p9':
      return { imported: 'invalid' };
    case 'est':
      return { imported: 'paid', est: 0n };
    case 'settle':
      return { imported: 'settled', settle: 0n };
  }
}

function enteringFrom(rebate: RebateStatus): string {
  return rebate === 'CLAWED_BACK' ? 'CREDITED' : 'ESTIMATED';
}

/** The report went through: platform_status / commission column updated as usual. */
async function expectApplied(f: Scenario, trigger: Trigger) {
  const row = await f.order();
  if (trigger === 'p9') expect(row.platform_status).toBe('RECEIVED');
  if (trigger === 'est') expect(row.est_commission_fen).toBe(500n);
  if (trigger === 'settle') expect(row.settle_commission_fen).toBe(1234n);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
}

/** Control: the same kind of report on a REFUND / COMMISSION_ZERO order registers exactly one diff. */
async function expectControlRegisters(trigger: Trigger) {
  const rebate: RebateStatus = trigger === 'settle' ? 'CLAWED_BACK' : 'VOID';
  const event = { p9: 'PLATFORM_INVALID', est: 'BASE_ZERO', settle: 'INVALID_AFTER_SETTLE' }[
    trigger
  ];
  const control = await scenario(db, {
    rebate,
    reason: trigger === 'est' ? 'COMMISSION_ZERO' : 'REFUND',
    entry: { from: enteringFrom(rebate), event, to: rebate },
    ...importedFor(trigger),
  });
  expect(await control.sync(CHANGE[trigger])).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const diffs = await control.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]?.dedupe_key).toBe(expectedKeys(control).dedupeKey);
  expect(control.restoreWarns()).toHaveLength(1);
}

it.each([
  ['VOID', 'BLACKLIST', 'BLACKLIST_HIT', 'p9'],
  ['VOID', 'BLACKLIST', 'BLACKLIST_HIT', 'est'],
  ['VOID', 'PUNISH', 'PUNISH', 'p9'],
  ['VOID', 'PUNISH', 'PUNISH', 'est'],
  ['CLAWED_BACK', 'BLACKLIST', 'BLACKLIST_CONFIRMED', 'settle'],
  ['CLAWED_BACK', 'PUNISH', 'PUNISH', 'settle'],
] as const)(
  '[AC-B1-08zc#10] 例（不告警）：%s(%s，进入事件 %s) 被平台恢复（%s）→ platform_status / 佣金照常更新，不登记、无 platform_restore 告警',
  async (rebate, reason, event, trigger) => {
    const f = await scenario(db, {
      rebate,
      reason,
      entry: { from: enteringFrom(rebate), event, to: rebate },
      ...importedFor(trigger),
    });
    expect(await f.sync(CHANGE[trigger])).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    await expectApplied(f, trigger);
    await expectNotRevived(f, rebate, reason);
    await expectNoRestore(f);
    // P9 自己的告警（B1-08i）不受本条影响。
    if (trigger === 'p9') expectP9Warn(f);
    await expectControlRegisters(trigger);
  },
);

it('[AC-B1-08zc#11] 前提看「进入当前返利状态的那条」历史：曾经 PLATFORM_INVALID 作废、恢复后又因 BLACKLIST_HIT 作废 → 不登记；最后一条是 PLATFORM_INVALID 的才登记且键用它的 id', async () => {
  const prior: readonly RebateStep[] = [
    { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
    { from: 'VOID', event: 'ADMIN_RESTORE', to: 'WAITING', source: 'admin' },
  ];
  const blacklisted = await scenario(db, {
    rebate: 'VOID',
    reason: 'BLACKLIST',
    prior,
    entry: { from: 'WAITING', event: 'BLACKLIST_HIT', to: 'VOID' },
    imported: 'paid',
    est: 0n,
  });
  expect(await blacklisted.sync(CHANGE.est)).toMatchObject({ ok: true });
  await expectApplied(blacklisted, 'est');
  await expectNoRestore(blacklisted);

  const refunded = await scenario(db, {
    rebate: 'VOID',
    reason: 'OTHER',
    prior: [
      { from: 'ESTIMATED', event: 'BLACKLIST_HIT', to: 'VOID' },
      { from: 'VOID', event: 'ADMIN_RESTORE', to: 'WAITING', source: 'admin' },
    ],
    entry: { from: 'WAITING', event: 'PLATFORM_INVALID', to: 'VOID' },
    imported: 'paid',
    est: 0n,
  });
  expect(await refunded.sync(CHANGE.est)).toMatchObject({ ok: true });
  const diffs = await refunded.diffs();
  expect(diffs).toHaveLength(1);
  const history = await refunded.rebateHistory();
  expect(history.map((row) => row.event)).toEqual([
    'BLACKLIST_HIT',
    'ADMIN_RESTORE',
    'PLATFORM_INVALID',
  ]);
  const entering = history[2];
  if (!entering) throw new Error('entering rebate row missing');
  expect(entering.id).toBe(refunded.entryId);
  const keys = expectedKeys(refunded, entering.id);
  expect(diffs[0]).toMatchObject({ ref_id: keys.refId, dedupe_key: keys.dedupeKey });
});

const RESTORED_PRIOR: Readonly<Record<'VOID' | 'CLAWED_BACK', readonly RebateStep[]>> = {
  VOID: [{ from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' }],
  CLAWED_BACK: [{ from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' }],
};

it.each([
  { rebate: 'UNATTRIBUTED', reason: null, restoredFrom: null, trigger: 'p9' },
  { rebate: 'ESTIMATED', reason: null, restoredFrom: null, trigger: 'p9' },
  { rebate: 'ESTIMATED', reason: 'REFUND', restoredFrom: 'VOID', trigger: 'est' },
  { rebate: 'WAITING', reason: 'REFUND', restoredFrom: 'VOID', trigger: 'est' },
  { rebate: 'CREDITED', reason: 'REFUND', restoredFrom: 'CLAWED_BACK', trigger: 'settle' },
] as const)(
  '[AC-B1-08zc#12] 返利状态不是 VOID / CLAWED_BACK（含已经 ADMIN_RESTORE 恢复、reason 仍为 REFUND 的）：$rebate 遇 $trigger 不登记',
  async ({ rebate, reason, restoredFrom, trigger }) => {
    const restored: Pick<RestoreSpec, 'prior' | 'entry'> =
      restoredFrom === null
        ? { entry: null }
        : {
            prior: RESTORED_PRIOR[restoredFrom],
            entry: { from: restoredFrom, event: 'ADMIN_RESTORE', to: rebate, source: 'admin' },
          };
    const f = await scenario(db, { rebate, reason, ...restored, ...importedFor(trigger) });
    expect(await f.sync(CHANGE[trigger])).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    await expectApplied(f, trigger);
    await expectNotRevived(f, rebate, reason);
    await expectNoRestore(f);
    await expectControlRegisters(trigger);
  },
);

it('[AC-B1-08zc#13] 佣金触发只认「由 ≤0 或空变为 >0」：>0 → 更大、>0 → 0、只改别的列、0 → 负数都不登记，再由负数变为 >0 才登记一张', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'COMMISSION_ZERO',
    entry: { from: 'ESTIMATED', event: 'BASE_ZERO', to: 'VOID' },
    imported: 'paid',
    est: 100n,
  });
  const quiet: readonly Report[] = [
    { est_commission_fen: 200n, commission_fen: 200n },
    { est_commission_fen: 0n, commission_fen: 0n },
    { paid_fen: 99_999n },
    { est_commission_fen: -10n, commission_fen: -10n },
  ];
  for (const change of quiet) {
    expect(await f.sync(change)).toMatchObject({ ok: true, value: { kind: 'updated' } });
    await expectNoRestore(f);
  }
  expect(await f.sync({ est_commission_fen: 456n, commission_fen: 456n })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    expected_fen: 456n,
    diff_fen: 456n,
    resolution: { trigger: 'commission', platform_status: 'PAID' },
  });
});

it('[AC-B1-08zc#14] 结算佣金同理：>0 → 更大、>0 → 0 不登记，0 → >0 登记（平台一直 SETTLED，没有 P9）', async () => {
  const f = await scenario(db, {
    rebate: 'CLAWED_BACK',
    reason: 'REFUND',
    entry: { from: 'CREDITED', event: 'INVALID_AFTER_SETTLE', to: 'CLAWED_BACK' },
    imported: 'settled',
    settle: 500n,
  });
  for (const settle of [600n, 0n]) {
    expect(await f.sync({ settle_commission_fen: settle })).toMatchObject({
      ok: true,
      value: { kind: 'updated' },
    });
    await expectNoRestore(f);
  }
  expect(await f.sync({ settle_commission_fen: 700n })).toMatchObject({ ok: true });
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    expected_fen: 700n,
    resolution: { trigger: 'commission', platform_status: 'SETTLED' },
  });
});

it('[AC-B1-08zc#15] 状态触发只认 P9：VOID(RIGHTS) 平台本来就未失效，PAID → RECEIVED（P3）不登记；之后佣金由 0 变为 >0 才登记', async () => {
  const f = await scenario(db, {
    rebate: 'VOID',
    reason: 'RIGHTS',
    entry: { from: 'ESTIMATED', event: 'RIGHTS_FULL', to: 'VOID' },
    imported: 'paid',
    est: 0n,
  });
  expect(await f.sync({ raw_status: 'received', received_at: at(RECEIVED) })).toMatchObject({
    ok: true,
    value: { kind: 'updated' },
  });
  expect((await f.order()).platform_status).toBe('RECEIVED');
  await expectNoRestore(f);
  expect(await f.sync({ est_commission_fen: 300n, commission_fen: 300n })).toMatchObject({
    ok: true,
  });
  const diffs = await f.diffs();
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    expected_fen: 300n,
    resolution: { trigger: 'commission', platform_status: 'RECEIVED', reason_code: 'RIGHTS' },
  });
});
