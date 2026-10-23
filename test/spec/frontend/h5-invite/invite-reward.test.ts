// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  configAnswer,
  configFailure,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  myInvite,
  reply,
  rewardLead,
  unavailable,
} from './invite-fixtures.ts';
import { controls, lastRule, mount, pageText, ruleCard, squash } from './invite-helpers.ts';

const REWARD_RULES = /活动规则/;
const RULES_FULL = new RegExp(copy.rulesFull);

function expectNoRewardCard(text: string): void {
  expect(text).not.toContain(squash(copy.rewardTitle));
  expect(text).not.toContain(squash(rewardLead));
  expect(controls(REWARD_RULES)).toEqual([]);
}

/** 活动无效时「不发放」一句是邀请规则卡的最后一条（BR-INV-18 细则，画板 InviteShare-v2）。 */
function expectNoRewardIsLastRule(): void {
  const card = ruleCard(copy.rulesTitle, RULES_FULL);
  // 定位到的是规则卡本身，不是整页。
  expect(squash(card.textContent)).not.toContain(inviteCode);
  expect(squash(card.textContent)).toContain(squash(copy.noReward));
  expect(
    lastRule(card, RULES_FULL).endsWith(squash(copy.noReward)),
    '「不发放红包或现金奖励」须是规则卡最后一条',
  ).toBe(true);
}

it('[AC-F1-05a-REWARD#1] 活动无效（reward_enabled=false）：规则卡最后一条是「不发放」一句，无奖励活动卡', async () => {
  const http = inviteServer({
    config: () => configAnswer(inviteConfig({ enabled: false, amount_fen: 1000 })),
  });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.noReward));
  expectNoRewardIsLastRule();
  expectNoRewardCard(text);
  expect(text).not.toContain('¥10');
});

it('[AC-F1-05a-REWARD#2] reward_enabled 缺省按无效：规则卡最后一条仍是「不发放」一句，无奖励活动卡', async () => {
  const http = inviteServer({ config: () => configAnswer(inviteConfig()) });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.noReward));
  expectNoRewardIsLastRule();
  expectNoRewardCard(text);
});

it('[AC-F1-05a-REWARD#3] 活动有效（经桥 app.getConfig 读 invite）：奖励活动卡用 tip_inviter，规则卡不再有「不发放」一句', async () => {
  const http = inviteServer({
    config: () => configAnswer(inviteConfig({ enabled: true, amount_fen: 1000 })),
  });
  const view = mount(http.api);
  await screen.findAllByText(copy.rewardTitle, { exact: false });
  const text = pageText(view.container);
  // BR-TEXT-10 H5 金额：1000 分 → ¥10（去尾零）。
  expect(text).toContain(squash(copy.rewardTip.replace('{amount}', '¥10')));
  expect(text).not.toContain(squash(copy.noReward));
  expect(squash(ruleCard(copy.rulesTitle, RULES_FULL).textContent)).not.toContain(
    squash(copy.noReward),
  );
  expect(text).toContain(inviteCode);
  expect(controls(REWARD_RULES)).toHaveLength(1);
  expect(text).not.toMatch(/\{amount\}|null|undefined|NaN/);
  // 规格 §4：getConfig 经桥读取，请求的键含 invite。
  const keys = http
    .calls('app.getConfig')
    .flatMap((request) => (request.params as { keys?: unknown[] } | undefined)?.keys ?? []);
  expect(keys).toContain('invite');
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
      config: () => configAnswer(inviteConfig({ enabled: true, amount_fen: fen })),
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
    config: () => configAnswer(inviteConfig({ enabled: true, amount_fen: 1000 })),
  });
  const view = mount(http.api);
  await screen.findAllByText(copy.unavailable, { exact: false });
  const text = pageText(view.container);
  expectNoRewardCard(text);
  expect(text).not.toContain('¥10');
});

it('[AC-F1-05a-REWARD#6] 经桥读取配置失败时按活动无效处理，邀请码照常显示', async () => {
  const http = inviteServer({
    invite: () => reply(myInvite()),
    config: () => configFailure,
  });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expectNoRewardCard(text);
  expect(controls(/复制邀请码/)).toHaveLength(1);
});
