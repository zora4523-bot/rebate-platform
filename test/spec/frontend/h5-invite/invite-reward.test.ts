// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  config,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  myInvite,
  reply,
  rewardLead,
  unavailable,
} from './invite-fixtures.ts';
import { controls, mount, pageText, squash } from './invite-helpers.ts';

const REWARD_RULES = /活动规则/;

function expectNoRewardCard(text: string): void {
  expect(text).not.toContain(squash(copy.rewardTitle));
  expect(text).not.toContain(squash(rewardLead));
  expect(controls(REWARD_RULES)).toEqual([]);
}

it('[AC-F1-05a-REWARD#1] 活动无效（reward_enabled=false）：规则卡有「不发放」一句，无奖励活动卡', async () => {
  const http = inviteServer({
    config: () => reply(config(inviteConfig({ enabled: false, amount_fen: 1000 }))),
  });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.noReward));
  expectNoRewardCard(text);
  expect(text).not.toContain('¥10');
});

it('[AC-F1-05a-REWARD#2] reward_enabled 缺省按无效：仍显示「不发放」一句，无奖励活动卡', async () => {
  const http = inviteServer({ config: () => reply(config(inviteConfig())) });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.noReward));
  expectNoRewardCard(text);
});

it('[AC-F1-05a-REWARD#3] 活动有效：奖励活动卡用 tip_inviter，规则卡不再有「不发放」一句', async () => {
  const http = inviteServer({
    config: () => reply(config(inviteConfig({ enabled: true, amount_fen: 1000 }))),
  });
  const view = mount(http.api);
  await screen.findAllByText(copy.rewardTitle, { exact: false });
  const text = pageText(view.container);
  // BR-TEXT-10 H5 金额：1000 分 → ¥10（去尾零）。
  expect(text).toContain(squash(copy.rewardTip.replace('{amount}', '¥10')));
  expect(text).not.toContain(squash(copy.noReward));
  expect(text).toContain(inviteCode);
  expect(controls(REWARD_RULES)).toHaveLength(1);
  expect(text).not.toMatch(/\{amount\}|null|undefined|NaN/);
});

it.each([
  { fen: 1550, money: '¥15.5' },
  { fen: 5, money: '¥0.05' },
  { fen: 123456, money: '¥1234.56' },
  { fen: 800, money: '¥8' },
])(
  '[AC-F1-05a-REWARD#4] 奖励金额取配置 reward_amount_fen=$fen，按 BR-TEXT-10 显示 $money',
  async ({ fen, money }) => {
    const http = inviteServer({
      config: () => reply(config(inviteConfig({ enabled: true, amount_fen: fen }))),
    });
    const view = mount(http.api);
    await screen.findAllByText(copy.rewardTitle, { exact: false });
    const text = pageText(view.container);
    expect(text).toContain(squash(copy.rewardTip.replace('{amount}', money)));
    // 不加千分位、不保留尾零。
    expect(text).not.toMatch(/¥1,234|¥15\.50|¥8\.00|¥8\.0(?!\d)/);
  },
);

it('[AC-F1-05a-REWARD#5] can_invite=false 时即使活动有效也不显示奖励活动卡与奖励句', async () => {
  const http = inviteServer({
    invite: () => reply(unavailable),
    config: () => reply(config(inviteConfig({ enabled: true, amount_fen: 1000 }))),
  });
  const view = mount(http.api);
  await screen.findAllByText(copy.unavailable, { exact: false });
  const text = pageText(view.container);
  expectNoRewardCard(text);
  expect(text).not.toContain('¥10');
});

it('[AC-F1-05a-REWARD#6] /v1/config 失败时按活动无效处理，邀请码照常显示', async () => {
  const http = inviteServer({
    invite: () => reply(myInvite()),
    config: () => reply(null, 50001, 500),
  });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expectNoRewardCard(text);
  expect(controls(/复制邀请码/)).toHaveLength(1);
});
