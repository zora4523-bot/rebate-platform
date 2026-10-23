import { expect, it } from 'vitest';
import { parseInviteReward } from './model.ts';

it('活动有效：取金额与有效天数', () => {
  expect(
    parseInviteReward({
      invite: { reward_enabled: true, reward_amount_fen: 1000, eligibility_days: 30 },
    }),
  ).toEqual({ amountFen: 1000n, eligibilityDays: 30 });
});

it('reward_enabled 缺省、为假或不是布尔真时按活动无效', () => {
  expect(parseInviteReward({ invite: { reward_amount_fen: 1000 } })).toBeNull();
  expect(
    parseInviteReward({ invite: { reward_enabled: false, reward_amount_fen: 1000 } }),
  ).toBeNull();
  expect(
    parseInviteReward({ invite: { reward_enabled: 'true', reward_amount_fen: 1000 } }),
  ).toBeNull();
  expect(parseInviteReward({})).toBeNull();
  expect(parseInviteReward(null)).toBeNull();
});

it('金额缺失、为零、负数或非整数时按活动无效', () => {
  for (const amount of [undefined, 0, -100, 10.5, '1000']) {
    expect(
      parseInviteReward({ invite: { reward_enabled: true, reward_amount_fen: amount } }),
    ).toBeNull();
  }
});

it('有效天数不是正整数时该条不显示（null），活动仍有效', () => {
  expect(
    parseInviteReward({
      invite: { reward_enabled: true, reward_amount_fen: 5, eligibility_days: 0 },
    }),
  ).toEqual({ amountFen: 5n, eligibilityDays: null });
});
