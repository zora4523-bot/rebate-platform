// B1-03v: the BR-ID-36 planning example end to end through the real AppModule — a frozen user's
// first, second and third appeals are upheld, the fourth is refused with HTTP 422 / 30418; the
// appeals carry the freeze's penalty_started_at and the list counts 1, 2, 3.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accepted,
  appeals,
  client,
  events,
  listed,
  openHttp,
  PATH,
  rejected,
  states,
  type Fixture,
} from '../appeals/http-kit.ts';
import {
  appealPenalty,
  attemptsById,
  penaltyOf,
  requirePenaltyColumns,
  uphold,
  type Driver,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-03v#30] 真 AppModule：同一冻结第 3 次被维持后第 4 次提交 HTTP 422 / 30418，不建单、状态与事件不变', async () => {
  const c = await client(f, 'frozen');
  await requirePenaltyColumns(f.db);
  const d: Driver = {
    db: f.db,
    clock: f.clock,
    riskState: c.risk,
    subject: { app_id: c.appId, user_id: c.uid },
  };
  const penalty = await penaltyOf(f.db, d.subject);
  expect(penalty).toBeInstanceOf(Date);
  const ids: string[] = [];
  for (const attempt of [1, 2, 3]) {
    f.clock.advanceMs(1000);
    const data = await accepted(
      await c.send('POST', PATH, { target_type: 'account', content: `第 ${attempt} 次申诉` }),
    );
    expect(data).toMatchObject({ status: 'processing', attempt_no: attempt, can_resubmit: false });
    expect(await appealPenalty(f.db, data.appeal_id)).toEqual(penalty);
    ids.push(data.appeal_id);
    await uphold(d, data.appeal_id);
  }
  const before = {
    appeals: await appeals(f, c),
    states: await states(f, c),
    events: await events(f, c),
  };
  f.clock.advanceMs(1000);
  await rejected(
    await c.send('POST', PATH, { target_type: 'account', content: '第 4 次申诉' }),
    422,
    30418,
  );
  expect(await appeals(f, c)).toEqual(before.appeals);
  expect(await states(f, c)).toEqual(before.states);
  expect(await events(f, c)).toEqual(before.events);
  const list = await listed(await c.send('GET', PATH));
  expect(attemptsById(list.items)).toEqual({
    [ids[0]!]: { attempt_no: 1, can_resubmit: false },
    [ids[1]!]: { attempt_no: 2, can_resubmit: false },
    [ids[2]!]: { attempt_no: 3, can_resubmit: false },
  });
});
