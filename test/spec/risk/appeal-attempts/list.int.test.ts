// B1-03v §9.2 items 4–5 (BR-ID-36 细则): in GET /v1/me/appeals every account appeal's attempt_no
// counts within its own penalty (target, penalty_started_at); can_resubmit is true only for the
// target's latest appeal, upheld, the account still restricted, and fewer than 3 appeals on the
// account's current penalty (the 30418 rule). Order appeals keep counting per order.
// Histories are seeded directly (the console closer does not exist yet, CT-24r); every state
// change goes through the single writer so user_risk_state.penalty_started_at is its own.
import { randomUUID } from 'node:crypto';
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
  type Driver,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

async function scenario(state: 'frozen' | 'banned') {
  const f = await fixture(kit, state);
  const start = f.clock.now();
  await requirePenaltyColumns(f.db);
  const d: Driver = { db: f.db, clock: f.clock, riskState: f.riskState, subject: f.subject };
  /** A closed account appeal on `penalty`, STEP_MS after the previous step. */
  async function upheld(penalty: Date | null, prev: 'frozen' | 'banned' = state) {
    f.clock.advanceMs(STEP_MS);
    return seedAppeal(f.db, f.subject, { created_at: f.clock.now(), penalty, prev });
  }
  async function order(target: string) {
    f.clock.advanceMs(STEP_MS);
    return seedAppeal(f.db, f.subject, {
      target_type: 'order',
      target_id: target,
      created_at: f.clock.now(),
      penalty: null,
    });
  }
  async function listed() {
    f.clock.advanceMs(STEP_MS);
    const service = await f.service();
    const page = await service.list(f.subject, { limit: 50 });
    expect(page.next_cursor).toBeNull();
    return attemptsById(page.items);
  }
  return { f, d, start, upheld, order, listed };
}

const no = (attempt_no: number) => ({ attempt_no, can_resubmit: false });
const yes = (attempt_no: number) => ({ attempt_no, can_resubmit: true });

it('[AC-B1-03v#23] 两次冻结各成一组：历史按各自组计，新组首条可再申诉，订单仍按订单累计；分页不影响计次', async () => {
  const s = await scenario('frozen');
  const orderX = randomUUID();
  const orderY = randomUUID();
  const a1 = await s.upheld(s.start);
  const o1 = await s.order(orderX);
  const a2 = await s.upheld(s.start);
  const o2 = await s.order(orderX);
  const a3 = await s.upheld(s.start);
  const o3 = await s.order(orderY);
  await setState(s.d, 'normal');
  const penalty = await setState(s.d, 'frozen');
  const b1 = await s.upheld(penalty);
  const o4 = await s.order(orderX);
  const expected = {
    [a1]: no(1),
    [a2]: no(2),
    [a3]: no(3),
    [b1]: yes(1),
    [o1]: no(1),
    [o2]: no(2),
    [o3]: no(1),
    [o4]: no(3),
  };
  expect(await s.listed()).toEqual(expected);

  // Page by page (limit 3): the counts never depend on which page an appeal falls on.
  const service = await s.f.service();
  const pages: Record<string, { attempt_no: number; can_resubmit: boolean }> = {};
  let cursor: string | undefined;
  for (let n = 0; n < 4; n += 1) {
    const page = await service.list(s.f.subject, {
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
    });
    Object.assign(pages, attemptsById(page.items));
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  expect(pages).toEqual(expected);

  // The next appeal is the second of the new freeze (not the fifth on the account).
  s.f.clock.advanceMs(STEP_MS);
  const next = success(await s.f.submit(service));
  expect(next).toMatchObject({ attempt_no: 2, can_resubmit: false });
  expect(await appealPenalty(s.f.db, next.appeal_id)).toEqual(penalty);
});

for (const state of ['frozen', 'banned'] as const) {
  for (const count of [1, 2, 3]) {
    it(`[AC-B1-03v#24] ${state} 当前处罚已维持 ${count} 次：最新一条 can_resubmit=${count < 3}，较早的为 false`, async () => {
      const s = await scenario(state);
      const ids: string[] = [];
      for (let n = 0; n < count; n += 1) ids.push(await s.upheld(s.start));
      expect(await s.listed()).toEqual(
        Object.fromEntries(
          ids.map((id, i) => [id, i === count - 1 && count < 3 ? yes(i + 1) : no(i + 1)]),
        ),
      );
    });
  }
}

it('[AC-B1-03v#25] 解除后不再受限：最新维持单 can_resubmit=false，计次不变', async () => {
  const s = await scenario('frozen');
  const a1 = await s.upheld(s.start);
  await setState(s.d, 'normal');
  expect(await s.listed()).toEqual({ [a1]: no(1) });
});

it('[AC-B1-03v#26] 旧处罚用满 3 次 → 解除 → 再冻结：新处罚尚无申诉，最新（旧组）维持单 can_resubmit=true', async () => {
  const s = await scenario('frozen');
  const ids: string[] = [];
  for (let n = 0; n < 3; n += 1) ids.push(await s.upheld(s.start));
  await setState(s.d, 'normal');
  await setState(s.d, 'frozen');
  expect(await s.listed()).toEqual({ [ids[0]!]: no(1), [ids[1]!]: no(2), [ids[2]!]: yes(3) });
});

for (const before of [2, 3]) {
  it(`[AC-B1-03v#27] 冻结组 ${before} 条后升级封禁：封禁组从 1 计且可再申诉，冻结组保持原计次`, async () => {
    const s = await scenario('frozen');
    const a: string[] = [];
    for (let n = 0; n < before; n += 1) a.push(await s.upheld(s.start));
    const penalty = await setState(s.d, 'banned');
    const b: string[] = [];
    for (let n = 0; n < 2; n += 1) b.push(await s.upheld(penalty, 'banned'));
    expect(await s.listed()).toEqual({
      ...Object.fromEntries(a.map((id, i) => [id, no(i + 1)])),
      [b[0]!]: no(1),
      [b[1]!]: yes(2),
    });
  });
}

it('[AC-B1-03v#28] 冻结延长不重计：同一冻结满 3 次后延长，最新一条 can_resubmit 仍为 false', async () => {
  const s = await scenario('frozen');
  const ids: string[] = [];
  for (let n = 0; n < 3; n += 1) ids.push(await s.upheld(s.start));
  await setState(s.d, 'frozen', new Date(s.f.clock.now().getTime() + 60 * 86400_000));
  expect(await penaltyOf(s.f.db, s.f.subject)).toEqual(s.start);
  expect(await s.listed()).toEqual({ [ids[0]!]: no(1), [ids[1]!]: no(2), [ids[2]!]: no(3) });
});

it('[AC-B1-03v#29] 存量数据（两侧 penalty_started_at 为空）退回近似口径：同一冻结内连续计次', async () => {
  const s = await scenario('frozen');
  await forgetPenalty(s.f.db, s.f.subject);
  const a1 = await s.upheld(null);
  const a2 = await s.upheld(null);
  expect(await s.listed()).toEqual({ [a1]: no(1), [a2]: yes(2) });
});
