import { expect, it } from 'vitest';
import { parseInviteLinks, parseInviteReward } from './model.ts';

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

it('help_links 两键都配置时原样取出跳转目标', () => {
  const rules = { route: 'Help', params: { article_id: 'a-1' } };
  const reward = { route: 'Help', params: { article_id: 'a-2' } };
  expect(
    parseInviteLinks({ help_links: { invite_rules: rules, invite_reward_rules: reward } }),
  ).toEqual({ rules, rewardRules: reward });
});

it('help_links 缺失、不是对象、缺键或目标不合法时对应入口为 null', () => {
  expect(parseInviteLinks({})).toEqual({ rules: null, rewardRules: null });
  expect(parseInviteLinks(null)).toEqual({ rules: null, rewardRules: null });
  expect(parseInviteLinks({ help_links: [] })).toEqual({ rules: null, rewardRules: null });
  expect(
    parseInviteLinks({
      help_links: {
        invite_rules: { route: '', params: { article_id: 'a-1' } },
        invite_reward_rules: { route: 'Help' },
      },
    }),
  ).toEqual({ rules: null, rewardRules: null });
});
