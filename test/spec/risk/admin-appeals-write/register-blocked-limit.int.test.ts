// B1-03ze spec-test round 3 (money r1 S1): the appeal count limit also binds blocked requests
// (BR-ID-36 细则「维持后再申诉」: the same object — one account, one order or one blocked request —
// at most 3 times including the first; 「客服代为登记的被拦截请求申诉同样受这个次数限制」; CT-24r
// adminRegisterAppeal: registered appeals count the same as appeals submitted in the app). Once a
// blocked request's appeals (target_type blocked_request, same target_id) have been upheld 3 times, a
// console registration on it is 30418: no appeal, no audit. The same rule as account appeals
// (AC-B1-03ze#70).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  REASON,
  appealOf,
  at,
  auditsOf,
  blocked,
  blockedAppeal,
  member,
  refused,
  resolution,
  setup,
  snapshot,
  type Blocked,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const CONTENT = '我只是正常操作，请帮我核查。';

const body = (targetId: string) => ({
  target_type: 'blocked_request',
  target_id: targetId,
  content: CONTENT,
  reason: REASON,
});

/** A request blocked 20 days ago, before every seeded appeal on it. */
async function request(s: Scenario, type: 'register' | 'withdraw'): Promise<Blocked> {
  if (type === 'register') {
    return blocked(s, { request_type: 'register', blocked_at: at(-20 * DAY) });
  }
  return blocked(s, {
    request_type: 'withdraw',
    user: await member(s),
    rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
    blocked_at: at(-20 * DAY),
  });
}

/** `count` upheld appeals on the blocked request, oldest first, all closed before now. */
async function upheld(s: Scenario, b: Blocked, count: number) {
  for (let n = 0; n < count; n += 1) {
    await blockedAppeal(s, b, { status: 'upheld', created_at: at(-(15 - 3 * n) * DAY) });
  }
}

it.each(['register', 'withdraw'] as const)(
  '[AC-B1-03ze#78] %s 类被拦请求的申诉已维持 3 次 → 代登记 30418，不建单、不写审计；维持 2 次时仍可登记第 3 次',
  async (type) => {
    const s = await setup(h);
    const usedUp = await request(s, type);
    const third = await request(s, type);
    await upheld(s, usedUp, 3);
    await upheld(s, third, 2);
    const before = await snapshot(s);
    await refused(await s.register(body(usedUp.id)), 30418);
    expect(await snapshot(s)).toEqual(before);
    expect(await auditsOf(s, 'appeal_register')).toEqual([]);
    const d = await appealOf(await s.register(body(third.id)));
    expect(d).toMatchObject({
      target_type: 'blocked_request',
      target_id: third.id,
      request_type: type,
      status: 'processing',
      source: 'admin',
      registered_by: s.a.id,
    });
    expect(await auditsOf(s, 'appeal_register')).toHaveLength(1);
  },
);

it('[AC-B1-03ze#79] 代登记并经后台维持的被拦请求申诉同样计次：已维持 2 次后代登记第 3 次、维持，再代登记 → 30418，不建单、不写审计', async () => {
  const s = await setup(h);
  const b = await request(s, 'register');
  await upheld(s, b, 2);
  const third = await appealOf(await s.register(body(b.id)));
  expect(third).toMatchObject({ status: 'processing', source: 'admin', registered_by: s.a.id });
  const closed = await appealOf(
    await s.resolve(third.appeal_id, resolution('upheld', third.row_version)),
  );
  expect(closed).toMatchObject({ appeal_id: third.appeal_id, status: 'upheld' });
  s.f.clock.advanceMs(60_000);
  const before = await snapshot(s);
  await refused(await s.register(body(b.id)), 30418);
  expect(await snapshot(s)).toEqual(before);
  expect(await auditsOf(s, 'appeal_register')).toHaveLength(1);
});
