// B1-03v §9.2 items 3–4 (BR-ID-36 细则; D10-147): an account appeal copies the current
// user_risk_state.penalty_started_at; attempt_no and the fourth-appeal 30418 count only the
// appeals of the current penalty (target, penalty_started_at). Upheld appeals are closed by the
// fixture closer in ./kit.ts (state put back through the single writer, then the appeal closed),
// because the console closer does not exist yet (CT-24r).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, fixture, openKit, success, type Kit } from '../appeals/service-kit.ts';
import {
  appealPenalty,
  attemptsById,
  forgetPenalty,
  penaltyOf,
  requirePenaltyColumns,
  seedAppeal,
  setState,
  STEP_MS,
  uphold,
  type Driver,
} from './kit.ts';

type Accepted = { readonly appeal_id: string };

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

async function scenario(state: 'frozen' | 'banned') {
  const f = await fixture(kit, state);
  // The fixture's first row was written at this instant: the penalty the account starts on.
  const start = f.clock.now();
  await requirePenaltyColumns(f.db);
  const service = await f.service();
  const d: Driver = { db: f.db, clock: f.clock, riskState: f.riskState, subject: f.subject };

  async function submit() {
    f.clock.advanceMs(STEP_MS);
    return f.submit(service);
  }
  /** A new appeal is accepted as attempt `attempt` of the penalty `penalty`. */
  async function accept(attempt: number, penalty: Date | null) {
    const data = success(await submit());
    expect(data, `attempt ${attempt}`).toMatchObject({
      target_type: 'account',
      status: 'processing',
      attempt_no: attempt,
      can_resubmit: false,
    });
    expect(await appealPenalty(f.db, data.appeal_id), `attempt ${attempt} penalty`).toEqual(
      penalty,
    );
    expect(await penaltyOf(f.db, f.subject), 'appealing keeps the penalty').toEqual(penalty);
    return data;
  }
  async function round(attempt: number, penalty: Date | null) {
    const data = await accept(attempt, penalty);
    await uphold(d, data.appeal_id);
    return data;
  }
  /** 30418: nothing inserted, the risk state and its events untouched. */
  async function usedUp() {
    const appeals = await f.appeals();
    const rows = await f.rows();
    const events = await f.eventRows();
    f.setRiskState.mockClear();
    f.publish.mockClear();
    expect(await submit()).toEqual({ code: 30418 });
    expect(await f.appeals()).toEqual(appeals);
    expect(await f.rows()).toEqual(rows);
    expect(await f.eventRows()).toEqual(events);
    expect(f.setRiskState).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  }
  async function listed() {
    const page = await service.list(f.subject, { limit: 50 });
    expect(page.next_cursor).toBeNull();
    return attemptsById(page.items);
  }
  return { f, d, start, service, submit, accept, round, usedUp, listed };
}

for (const state of ['frozen', 'banned'] as const) {
  it(`[AC-B1-03v#16] ${state} 账户申诉建单复制当前 penalty_started_at，进入申诉中不改它`, async () => {
    const s = await scenario(state);
    expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(s.start);
    const first = await s.round(1, s.start);
    expect(await penaltyOf(s.f.db, s.f.subject), 'upheld restore keeps it').toEqual(s.start);
    const second = await s.accept(2, s.start);
    expect(second.appeal_id).not.toBe(first.appeal_id);
    expect(await appealPenalty(s.f.db, first.appeal_id)).toEqual(s.start);
  });
}

it('[AC-B1-03v#17] 规划例子：同一冻结第 1、2、3 次均被维持，第 4 次 30418，不建单、风控状态不变', async () => {
  const s = await scenario('frozen');
  const appeals: Accepted[] = [];
  for (const attempt of [1, 2, 3]) appeals.push(await s.round(attempt, s.start));
  await s.usedUp();
  expect(await s.listed()).toEqual(
    Object.fromEntries(
      appeals.map((a, i) => [a.appeal_id, { attempt_no: i + 1, can_resubmit: false }]),
    ),
  );
});

for (const state of ['frozen', 'banned'] as const) {
  for (const before of [2, 3]) {
    it(`[AC-B1-03v#18] ${state} 处罚 A 维持 ${before} 次 → 解除 → 处罚 B：B 从第 1 次计、可满 3 次，第 4 次才 30418`, async () => {
      const s = await scenario(state);
      const a: Accepted[] = [];
      for (let attempt = 1; attempt <= before; attempt += 1) {
        a.push(await s.round(attempt, s.start));
      }
      if (before === 3) await s.usedUp();
      await setState(s.d, 'normal');
      expect(await penaltyOf(s.f.db, s.f.subject)).toBeNull();
      const penalty = await setState(s.d, state);
      expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(penalty);
      // CT-26e gap: the display count right after the insert must start the new penalty at 1.
      const b1 = await s.accept(1, penalty);
      // The processing appeal is returned as it is, still attempt 1 of penalty B.
      expect(success(await s.submit())).toEqual(b1);
      await uphold(s.d, b1.appeal_id);
      const b2 = await s.round(2, penalty);
      const b3 = await s.round(3, penalty);
      await s.usedUp();
      expect(await s.listed()).toEqual({
        ...Object.fromEntries(
          a.map((row, i) => [row.appeal_id, { attempt_no: i + 1, can_resubmit: false }]),
        ),
        [b1.appeal_id]: { attempt_no: 1, can_resubmit: false },
        [b2.appeal_id]: { attempt_no: 2, can_resubmit: false },
        [b3.appeal_id]: { attempt_no: 3, can_resubmit: false },
      });
    });
  }
}

for (const before of [2, 3]) {
  it(`[AC-B1-03v#19] 冻结中维持 ${before} 次后升级封禁：新处罚从 1 计，封禁满 3 次后 30418`, async () => {
    const s = await scenario('frozen');
    const a: Accepted[] = [];
    for (let attempt = 1; attempt <= before; attempt += 1) {
      a.push(await s.round(attempt, s.start));
    }
    if (before === 3) await s.usedUp();
    const penalty = await setState(s.d, 'banned');
    expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(penalty);
    const b: Accepted[] = [];
    for (const attempt of [1, 2, 3]) b.push(await s.round(attempt, penalty));
    expect((await s.f.appeals()).filter((row) => row.prev_risk_state === 'banned')).toHaveLength(3);
    await s.usedUp();
    expect(await s.listed()).toEqual({
      ...Object.fromEntries(
        a.map((row, i) => [row.appeal_id, { attempt_no: i + 1, can_resubmit: false }]),
      ),
      ...Object.fromEntries(
        b.map((row, i) => [row.appeal_id, { attempt_no: i + 1, can_resubmit: false }]),
      ),
    });
  });
}

it('[AC-B1-03v#20] 冻结延长不重计：维持 2 次 → 延长 → 第 3 次受理 → 第 4 次 30418', async () => {
  const s = await scenario('frozen');
  await s.round(1, s.start);
  await s.round(2, s.start);
  await setState(s.d, 'frozen', new Date(s.f.clock.now().getTime() + 60 * 86400_000));
  expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(s.start);
  await s.round(3, s.start);
  await s.usedUp();
});

it('[AC-B1-03v#21] 冻结延长不重计：同一冻结维持满 3 次后延长，再提交仍 30418', async () => {
  const s = await scenario('frozen');
  for (const attempt of [1, 2, 3]) await s.round(attempt, s.start);
  await s.usedUp();
  await setState(s.d, 'frozen', new Date(s.f.clock.now().getTime() + 60 * 86400_000));
  expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(s.start);
  await s.usedUp();
});

it('[AC-B1-03v#22] 存量数据（风控状态与历史申诉 penalty_started_at 为空）退回近似口径：第 3 次受理、第 4 次 30418', async () => {
  const s = await scenario('frozen');
  await forgetPenalty(s.f.db, s.f.subject);
  // Two upheld appeals from before the migration, after the freeze was set (changed_at = start).
  for (const n of [1, 2]) {
    await seedAppeal(s.f.db, s.f.subject, {
      created_at: new Date(s.start.getTime() + n * 60_000),
      penalty: null,
    });
  }
  // The new appeal copies the unknown penalty: null.
  const third = await s.round(3, null);
  expect(await appealPenalty(s.f.db, third.appeal_id)).toBeNull();
  await s.usedUp();
});
