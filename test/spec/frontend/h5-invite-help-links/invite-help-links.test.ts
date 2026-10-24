// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  config,
  configFailure,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  reply,
  unavailable,
  type ConfigAnswer,
  type HelpLinkTarget,
  type InviteServer,
} from '../h5-invite/invite-fixtures.ts';
import {
  controls,
  entry,
  mount,
  pageText,
  squash,
  visitedLocations,
} from '../h5-invite/invite-helpers.ts';

// 契约 CT-16n（D10-252）：/v1/config help_links 的 invite_rules →【完整规则】，invite_reward_rules →
// 【活动规则】；键 → 跳转目标 {route: 'Help', params: {article_id}}，键未配置的入口不显示。
// 样例文章标识是明显的假 UUID，与 h5-invite 夹具的不同，确保页面读的是本用例给的配置。
const RULES_TARGET: HelpLinkTarget = {
  route: 'Help',
  params: { article_id: '00000000-0000-4000-8000-00000c05f001' },
};
const REWARD_RULES_TARGET: HelpLinkTarget = {
  route: 'Help',
  params: { article_id: '00000000-0000-4000-8000-00000c05f002' },
};
const BOTH_LINKS = { invite_rules: RULES_TARGET, invite_reward_rules: REWARD_RULES_TARGET };

const RULES_FULL = new RegExp(copy.rulesFull);
const REWARD_RULES = new RegExp(copy.rewardRules);
const rewardSentence = copy.rewardTip.replace('{amount}', '¥10');

/**
 * app.getConfig 的原生应答：invite 段按活动有效 / 无效给，help_links 照传入的原样给；
 * 传 undefined 表示 /v1/config 里没有 help_links 这一项。
 */
function answer(
  rewardOn: boolean,
  links: Record<string, HelpLinkTarget> | undefined,
): ConfigAnswer {
  const values: Record<string, unknown> = {
    ...config(inviteConfig({ enabled: rewardOn, amount_fen: 1000 })),
  };
  delete values['help_links'];
  if (links !== undefined) values['help_links'] = links;
  return { values };
}

/** 页面经桥 nav.open 打开 Help 的参数（{route, params} 整体），按调用顺序。 */
function helpOpens(http: InviteServer): unknown[] {
  return http
    .calls('nav.open')
    .map((request) => request.params)
    .filter((params) => (params as { route?: unknown } | undefined)?.route === 'Help');
}

async function ready(rewardOn: boolean): Promise<void> {
  if (rewardOn) await screen.findAllByText(copy.rewardTitle, { exact: false });
  else await screen.findAllByText(inviteCode, { exact: false });
}

it('[AC-F1-05c-OPEN#1] 活动无效时【完整规则】经桥 nav.open 按 help_links.invite_rules 的目标原样打开，没有活动规则入口', async () => {
  const http = inviteServer({ config: () => answer(false, BOTH_LINKS) });
  mount(http.api);
  await ready(false);
  expect(controls(REWARD_RULES)).toEqual([]);
  expect(helpOpens(http)).toEqual([]);
  await userEvent.setup().click(entry(RULES_FULL));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(1));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f001' } },
  ]);
  // 经桥打开，不在 H5 内另起站内跳转。
  expect(visitedLocations()).toEqual([]);
});

it('[AC-F1-05c-OPEN#2] 活动有效时【活动规则】按 invite_reward_rules、【完整规则】按 invite_rules 各自打开', async () => {
  const http = inviteServer({ config: () => answer(true, BOTH_LINKS) });
  mount(http.api);
  await ready(true);
  const user = userEvent.setup();
  await user.click(entry(REWARD_RULES));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(1));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f002' } },
  ]);
  await user.click(entry(RULES_FULL));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(2));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f002' } },
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f001' } },
  ]);
  expect(visitedLocations()).toEqual([]);
});

it('[AC-F1-05c-OPEN#3] 暂不可邀请（can_invite=false）时【完整规则】仍按 invite_rules 打开，没有活动规则入口', async () => {
  const http = inviteServer({
    invite: () => reply(unavailable),
    config: () => answer(true, BOTH_LINKS),
  });
  mount(http.api);
  await screen.findAllByText(copy.unavailable, { exact: false });
  expect(controls(REWARD_RULES)).toEqual([]);
  await userEvent.setup().click(entry(RULES_FULL));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(1));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f001' } },
  ]);
});

it('[AC-F1-05c-HIDE#1] 活动无效且 help_links 缺 invite_rules：没有【完整规则】入口，邀请规则卡标题与规则照常显示', async () => {
  const http = inviteServer({
    config: () => answer(false, { invite_reward_rules: REWARD_RULES_TARGET }),
  });
  const view = mount(http.api);
  await ready(false);
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.noReward));
  expect(controls(RULES_FULL)).toEqual([]);
  expect(controls(REWARD_RULES)).toEqual([]);
  expect(helpOpens(http)).toEqual([]);
});

it('[AC-F1-05c-HIDE#2] 活动有效且缺 invite_rules：没有【完整规则】入口，【活动规则】仍按 invite_reward_rules 打开', async () => {
  const http = inviteServer({
    config: () => answer(true, { invite_reward_rules: REWARD_RULES_TARGET }),
  });
  const view = mount(http.api);
  await ready(true);
  expect(pageText(view.container)).toContain(squash(copy.rulesTitle));
  expect(controls(RULES_FULL)).toEqual([]);
  await userEvent.setup().click(entry(REWARD_RULES));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(1));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f002' } },
  ]);
});

it('[AC-F1-05c-HIDE#3] 活动有效且缺 invite_reward_rules：奖励活动卡标题与奖励句照常显示，只是没有【活动规则】入口', async () => {
  const http = inviteServer({ config: () => answer(true, { invite_rules: RULES_TARGET }) });
  const view = mount(http.api);
  await ready(true);
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.rewardTitle));
  expect(text).toContain(squash(rewardSentence));
  expect(text).not.toContain(squash(copy.noReward));
  expect(controls(REWARD_RULES)).toEqual([]);
  await userEvent.setup().click(entry(RULES_FULL));
  await waitFor(() => expect(helpOpens(http)).toHaveLength(1));
  expect(helpOpens(http)).toEqual([
    { route: 'Help', params: { article_id: '00000000-0000-4000-8000-00000c05f001' } },
  ]);
});

it('[AC-F1-05c-HIDE#4] 配置里没有 help_links：【完整规则】【活动规则】都不显示，邀请规则卡与奖励活动卡照常', async () => {
  const http = inviteServer({ config: () => answer(true, undefined) });
  const view = mount(http.api);
  await ready(true);
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.rewardTitle));
  expect(text).toContain(squash(rewardSentence));
  expect(controls(RULES_FULL)).toEqual([]);
  expect(controls(REWARD_RULES)).toEqual([]);
  expect(helpOpens(http)).toEqual([]);
});

it('[AC-F1-05c-HIDE#5] help_links 为空对象：两入口都不显示，邀请码与邀请规则卡照常', async () => {
  const http = inviteServer({ config: () => answer(false, {}) });
  const view = mount(http.api);
  await ready(false);
  const text = pageText(view.container);
  expect(text).toContain(inviteCode);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.noReward));
  expect(controls(RULES_FULL)).toEqual([]);
  expect(controls(REWARD_RULES)).toEqual([]);
});

it('[AC-F1-05c-HIDE#6] 经桥读取配置失败：两入口都不显示，邀请码与邀请规则卡（含不发放一句）照常', async () => {
  const http = inviteServer({ config: () => configFailure });
  const view = mount(http.api);
  await ready(false);
  const text = pageText(view.container);
  expect(text).toContain(inviteCode);
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).toContain(squash(copy.noReward));
  expect(text).not.toContain(squash(copy.rewardTitle));
  expect(controls(/复制邀请码/)).toHaveLength(1);
  expect(controls(RULES_FULL)).toEqual([]);
  expect(controls(REWARD_RULES)).toEqual([]);
});

it('[AC-F1-05c-CONFIG#1] help_links 与 invite 一样只经桥 app.getConfig 读取，不另发 HTTP 读 /v1/config', async () => {
  const http = inviteServer({ config: () => answer(true, BOTH_LINKS) });
  mount(http.api);
  await ready(true);
  const requested = http
    .calls('app.getConfig')
    .flatMap((request) => (request.params as { keys?: unknown[] } | undefined)?.keys ?? []);
  expect(requested).toEqual(expect.arrayContaining(['invite', 'help_links']));
  expect(http.requests.map((request) => new URL(request.url).pathname)).not.toContain('/v1/config');
});
