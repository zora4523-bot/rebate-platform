// B1-03v §9.2 item 2: setRiskState (the single writer of user_risk_state) sets
// penalty_started_at to the change instant (injected Clock) when a penalty starts — normal (or no
// row) → frozen / banned, and frozen → banned (D10-147: a new penalty) — keeps it when entering
// appealing, when an upheld appeal puts the state back, and when a freeze is extended
// (frozen → frozen), and clears it on the way back to normal.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, fixture, openKit, type Kit } from '../risk-state/service-kit.ts';
import { penaltyOf, requirePenaltyColumns, setState, STEP_MS, type Driver } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

async function driver(): Promise<Driver & { changedAt(): Promise<Date> }> {
  const f = await fixture(kit);
  const riskState = f.service();
  return {
    db: f.db,
    clock: f.clock,
    riskState,
    subject: f.subject,
    async changedAt() {
      const rows = await f.rows();
      expect(rows).toHaveLength(1);
      return rows[0]!.changed_at;
    },
  };
}

/** appealing with the row's reason / category / frozen_until kept, as submit does. */
async function appeal(d: Driver, state: 'frozen' | 'banned', frozenUntil: Date | null) {
  d.clock.advanceMs(STEP_MS);
  await d.db.transaction().execute((trx) =>
    d.riskState.setRiskState(trx, {
      ...d.subject,
      state: 'appealing',
      reason: `fixture ${state}`,
      reason_category: 'other',
      frozen_until: frozenUntil,
      changed_by: `user:${d.subject.user_id}`,
    }),
  );
}

/** appealing → the previous state (an upheld appeal), reason / category / frozen_until kept. */
async function restore(d: Driver, state: 'frozen' | 'banned', frozenUntil: Date | null) {
  d.clock.advanceMs(STEP_MS);
  await d.db.transaction().execute((trx) =>
    d.riskState.setRiskState(trx, {
      ...d.subject,
      state,
      reason: `fixture ${state}`,
      reason_category: 'other',
      frozen_until: frozenUntil,
      changed_by: 'admin:fixture',
    }),
  );
}

for (const state of ['frozen', 'banned'] as const) {
  it(`[AC-B1-03v#8] 无行（视同 normal）直接置 ${state}：penalty_started_at = 本次变更时刻`, async () => {
    const d = await driver();
    await requirePenaltyColumns(d.db);
    const at = await setState(d, state);
    expect(await penaltyOf(d.db, d.subject)).toEqual(at);
    expect(await d.changedAt()).toEqual(at);
  });

  it(`[AC-B1-03v#9] normal → ${state} 写入变更时刻；回到 normal 置空；再处罚取新时刻`, async () => {
    const d = await driver();
    await requirePenaltyColumns(d.db);
    await setState(d, 'normal');
    expect(await penaltyOf(d.db, d.subject)).toBeNull();
    const first = await setState(d, state);
    expect(await penaltyOf(d.db, d.subject)).toEqual(first);
    await setState(d, 'normal');
    expect(await penaltyOf(d.db, d.subject)).toBeNull();
    const second = await setState(d, state);
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(await penaltyOf(d.db, d.subject)).toEqual(second);
  });

  it(`[AC-B1-03v#10] ${state} → appealing → ${state}（进入申诉、维持还原）不改 penalty_started_at`, async () => {
    const d = await driver();
    await requirePenaltyColumns(d.db);
    const until = state === 'frozen' ? new Date(d.clock.now().getTime() + 30 * 86400_000) : null;
    const started = await setState(d, state, until ?? undefined);
    for (let round = 0; round < 3; round += 1) {
      await appeal(d, state, until);
      expect(await penaltyOf(d.db, d.subject), `appealing #${round + 1}`).toEqual(started);
      await restore(d, state, until);
      expect(await penaltyOf(d.db, d.subject), `restored #${round + 1}`).toEqual(started);
    }
    expect((await d.changedAt()).getTime()).toBeGreaterThan(started.getTime());
  });

  it(`[AC-B1-03v#11] ${state} → appealing → normal（撤销）置空`, async () => {
    const d = await driver();
    await requirePenaltyColumns(d.db);
    await setState(d, state);
    await appeal(d, state, null);
    await setState(d, 'normal');
    expect(await penaltyOf(d.db, d.subject)).toBeNull();
  });
}

it('[AC-B1-03v#12] 冻结期间升级为封禁是新处罚：penalty_started_at = 升级时刻', async () => {
  const d = await driver();
  await requirePenaltyColumns(d.db);
  const frozen = await setState(d, 'frozen');
  expect(await penaltyOf(d.db, d.subject)).toEqual(frozen);
  const banned = await setState(d, 'banned');
  expect(banned.getTime()).toBeGreaterThan(frozen.getTime());
  expect(await penaltyOf(d.db, d.subject)).toEqual(banned);
  // An appeal on the ban and its upheld restore stay on the ban's penalty.
  await appeal(d, 'banned', null);
  await restore(d, 'banned', null);
  expect(await penaltyOf(d.db, d.subject)).toEqual(banned);
});

it('[AC-B1-03v#13] 冻结再冻结（延长或改期）不是新处罚：penalty_started_at 不变', async () => {
  const d = await driver();
  await requirePenaltyColumns(d.db);
  const started = await setState(d, 'frozen');
  const later = new Date(d.clock.now().getTime() + 60 * 86400_000);
  await setState(d, 'frozen', later);
  expect(await penaltyOf(d.db, d.subject)).toEqual(started);
  await setState(d, 'frozen');
  expect(await penaltyOf(d.db, d.subject)).toEqual(started);
});

it('[AC-B1-03v#14] 封禁再封禁（改原因）不是新处罚：penalty_started_at 不变', async () => {
  const d = await driver();
  await requirePenaltyColumns(d.db);
  const started = await setState(d, 'banned');
  await setState(d, 'banned');
  expect(await penaltyOf(d.db, d.subject)).toEqual(started);
});

it('[AC-B1-03v#15] 无行直接置 normal：penalty_started_at 为空', async () => {
  const d = await driver();
  await requirePenaltyColumns(d.db);
  await setState(d, 'normal');
  expect(await penaltyOf(d.db, d.subject)).toBeNull();
});
