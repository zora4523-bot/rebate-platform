// B1-02zq §9 #9: withdraw.dormant_reverify_days = 0 with no flag changes nothing. A flag with the
// switch at 0 is not in the rule and is not written here (the task's output). The app with the
// switch at 180 holds the control: the gate is wired, and it is the missing flag that lets the
// others through.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeKit, openKit, type Kit } from '../reverify/kit.ts';
import { MANUAL, RULES, SURFACES, answer, gates, refused } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it.each(SURFACES)('[AC-B1-02zq#42] $name：开关为 0 且无标记 → 行为不变', async (s) => {
  const live = await gates(kit);
  const flagged = await live.member(s.member);
  await live.flag(flagged.uid, { realname: false, providers: [] });
  refused(kit, s.path, s.verb, await s.submit(live.on(flagged)), MANUAL);

  const off = await gates(kit, { days: 0 });
  const m = await off.member(s.member);
  s.ready(kit);
  s.accepted(kit, await s.submit(off.on(m)));
});

it('[AC-B1-02zq#43] rules：开关为 0 且无标记 → 可提现，不出现 block_code', async () => {
  const live = await gates(kit);
  const flagged = await live.member();
  await live.flag(flagged.uid, { realname: false, providers: [] });
  expect(answer(kit, RULES, 'get', await live.on(flagged).rules(), 0).data).toMatchObject({
    block_code: 10010,
  });

  const off = await gates(kit, { days: 0 });
  const m = await off.member();
  expect(answer(kit, RULES, 'get', await off.on(m).rules(), 0).data).toMatchObject({
    can_withdraw: true,
    block_code: null,
  });
});
