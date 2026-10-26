// B1-27g · the monthly change count around a correction (08 BR-WDR-02 细则「实名更正后的失效与重绑」:
// 这次失效与其后第一次重新绑定不计入每月变更次数（用户非自愿）; ④; 04 §3.2 limit_exempt_reason; task
// §9.4): a correction is accepted however many changes the month has used; it writes one exempt
// change row; afterwards GET /v1/me/payout-account shows no account; the first binding after it
// succeeds even with a full month, writes no change row and leaves change_remaining_this_month as it
// was before the correction; the change after that is an ordinary one and counts.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { body, correct, ok, user, verified } from '../admin-realname/kit.ts';
import {
  ALIPAY,
  EXEMPT,
  LIMIT,
  bound,
  change,
  changesOf,
  memberSide,
  payoutState,
  rebind,
  setup,
  view,
} from './kit.ts';

const h = useHarness();

const FULL = { code: 30303, data: { reason: 'payout_account_change_limit' } };

it.each([
  { used: LIMIT, next: FULL },
  { used: LIMIT - 1, next: { code: 0, data: { change_remaining_this_month: 0 } } },
])(
  '[AC-B1-27g#5] 本月已用 $used 次：更正照常受理并写一条 exempt 行；GET 无账号；首次重绑成功、不写变更行、剩余与更正前相同；再换绑才计次',
  async ({ used, next }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    await verified(h, target);
    const old = await bound(h, target, 'alipay', true, 'old.payee@example.com');
    for (let i = 0; i < used; i++) await change(h, target, s.clock.now());
    const app = await memberSide(s, target);
    const remaining = LIMIT - used;
    expect(await view(await app.get())).toMatchObject({
      payout_account_id: old.id,
      change_remaining_this_month: remaining,
    });
    const ordinary = await changesOf(h, target);

    await ok(await correct(s, target.id, body()));
    const corrected = await changesOf(h, target);
    expect(corrected.slice(0, used)).toEqual(ordinary);
    expect(corrected.map((row) => row.limit_exempt_reason)).toEqual([
      ...ordinary.map(() => null),
      EXEMPT,
    ]);
    expect(await view(await app.get())).toEqual({});

    // The first binding after the correction, under the corrected name, with a full month too.
    const rebound = await rebind(s, target, 'new.payee@example.com');
    expect(rebound).toMatchObject({ code: 0, data: { change_remaining_this_month: remaining } });
    const after = await payoutState(h, target);
    expect(after.changes).toEqual(corrected);
    const current = after.accounts.filter((account) => account.is_current);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).not.toBe(old.id);
    expect(current[0]!.alipay_hmac).toBe(h.fields.blindIndex('new.payee@example.com', ALIPAY));
    expect(await view(await app.get())).toMatchObject({
      payout_account_id: current[0]!.id,
      change_remaining_this_month: remaining,
    });

    // Only that first binding is free: the next change is an ordinary one.
    expect(await rebind(s, target, 'next.payee@example.com')).toMatchObject(next);
  },
);

it('[AC-B1-27g#6] 更正当月的 exempt 行不占名额：更正后重绑、再换绑用满剩余名额，与没有过更正时的次数一致', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await bound(h, target, 'bank_card', true, '6222021234567890123');
  await ok(await correct(s, target.id, body()));
  expect((await changesOf(h, target)).map((row) => row.limit_exempt_reason)).toEqual([EXEMPT]);
  const app = await memberSide(s, target);
  expect(await view(await app.get())).toEqual({});

  expect(await rebind(s, target, 'first.payee@example.com')).toMatchObject({
    code: 0,
    data: { change_remaining_this_month: LIMIT },
  });
  for (let left = LIMIT - 1; left >= 0; left--) {
    expect(await rebind(s, target, `change${left}.payee@example.com`)).toMatchObject({
      code: 0,
      data: { change_remaining_this_month: left },
    });
  }
  expect(await rebind(s, target, 'over.payee@example.com')).toEqual(FULL);
  expect(await view(await app.get())).toMatchObject({ change_remaining_this_month: 0 });
  expect((await changesOf(h, target)).map((row) => row.limit_exempt_reason)).toEqual([
    EXEMPT,
    ...Array.from({ length: LIMIT }, () => null),
  ]);
});
