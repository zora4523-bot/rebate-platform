// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  config,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  landingUrl,
  myInvite,
  posterUrl,
  reply,
} from './invite-fixtures.ts';
import {
  controls,
  entry,
  expectNotice,
  mount,
  navigations,
  noticeShown,
  openedHelpArticles,
  savePoster,
  visitedLocations,
} from './invite-helpers.ts';

const COPY_CODE = /复制邀请码/;
const COPY_LINK = /复制邀请链接/;
const SAVE_POSTER = /保存海报/;

function clipboardTexts(http: ReturnType<typeof inviteServer>): unknown[] {
  return http
    .calls('clipboard.write')
    .map((request) => (request.params as { text?: unknown } | undefined)?.text);
}

it('[AC-F1-05a-COPY#1] 【复制邀请码】经 clipboard.write 写入 invite_code 并提示已复制邀请码', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  expect(noticeShown(http, copy.copyCodeDone)).toBe(false);
  await userEvent.setup().click(entry(COPY_CODE));
  await waitFor(() => expect(clipboardTexts(http)).toEqual([inviteCode]));
  await expectNotice(http, copy.copyCodeDone);
  expect(noticeShown(http, copy.copyLinkDone)).toBe(false);
  expect(http.calls('share.open')).toEqual([]);
});

it('[AC-F1-05a-COPY#2] 【复制邀请链接】写入 landing_url 原样并提示已复制邀请链接', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  expect(noticeShown(http, copy.copyLinkDone)).toBe(false);
  await userEvent.setup().click(entry(COPY_LINK));
  await waitFor(() => expect(clipboardTexts(http)).toEqual([landingUrl]));
  await expectNotice(http, copy.copyLinkDone);
  expect(noticeShown(http, copy.copyCodeDone)).toBe(false);
});

it('[AC-F1-05a-COPY#3] 复制按钮的读屏名带对象且两个按钮可区分', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const code = entry(COPY_CODE);
  const link = entry(COPY_LINK);
  expect(code).not.toBe(link);
  expect(code.getAttribute('disabled')).toBeNull();
  expect(link.getAttribute('disabled')).toBeNull();
  // 读屏名不能只有「复制」：须说明复制的是邀请码 / 邀请链接。
  expect(screen.queryAllByRole('button', { name: /^\s*复制\s*$/ })).toEqual([]);
});

it('[AC-F1-05a-SHARE#1] 系统分享经 share.open 分享 landing_url 链接', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const share = controls(/分享/).filter((element) => !COPY_LINK.test(element.textContent ?? ''));
  expect(share, '邀请链接的系统分享入口').toHaveLength(1);
  await userEvent.setup().click(share[0]!);
  await waitFor(() => expect(http.calls('share.open')).toHaveLength(1));
  const params = http.calls('share.open')[0]!.params as {
    channel?: string;
    content: { type: string; url?: string; title?: string };
  };
  expect(params.content.type).toBe('link');
  expect(params.content.url).toBe(landingUrl);
  expect((params.content.title ?? '').trim()).not.toBe('');
  expect([undefined, 'system']).toContain(params.channel);
  // 分享内容不带 UID、手机号或昵称（契约 landing_url 说明）；只用接口给的链接。
  expect(JSON.stringify(params)).not.toMatch(/uid|user_id|phone|nickname/i);
});

it('[AC-F1-05a-POSTER#1] 【保存海报】预览服务端出图 poster_url，保存走 media.saveImage', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const user = userEvent.setup();
  const { previewed } = await savePoster(user, http, SAVE_POSTER, posterUrl);
  expect(previewed, '海报预览显示服务端出图 poster_url').toBe(true);
  expect(http.calls('media.saveImage').map((request) => request.params)).toEqual([
    { urls: [posterUrl] },
  ]);
  // 只用服务端出图，不在页面里另画海报。
  expect(document.querySelector('canvas')).toBeNull();
});

it('[AC-F1-05a-POSTER#2] poster_url 为空时保存海报不可用或不出现，点了也不调用保存', async () => {
  const http = inviteServer({ invite: () => reply(myInvite({ poster_url: null })) });
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const user = userEvent.setup();
  for (const element of controls(SAVE_POSTER)) {
    expect(
      element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      '没有海报图时按钮须不可用',
    ).toBe(true);
    await user.click(element).catch(() => undefined);
  }
  expect(http.calls('media.saveImage')).toEqual([]);
  expect(http.calls('media.previewImage')).toEqual([]);
  expect(screen.queryByRole('dialog')).toBeNull();
  // 复制入口不受影响。
  expect(controls(COPY_CODE)).toHaveLength(1);
  expect(controls(COPY_LINK)).toHaveLength(1);
});

it('[AC-F1-05a-POSTER#3] 相册权限被拒（saved=false）显示被拒提示，页面不崩溃可继续操作', async () => {
  const http = inviteServer({
    saveImage: (request) => ({ id: request.id, code: 0, msg: '', data: { saved: false } }),
  });
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const user = userEvent.setup();
  await savePoster(user, http, SAVE_POSTER, posterUrl);
  await expectNotice(http, copy.photosDenied);
  expect(screen.getAllByText(inviteCode, { exact: false }).length).toBeGreaterThan(0);
  expect(screen.queryByText(copy.loadFailed, { exact: false })).toBeNull();
  expect(controls(COPY_CODE).length).toBeGreaterThan(0);
});

it('[AC-F1-05a-LINK#1] 人数卡说明「在余额流水里查看」进入 Ledger', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  await userEvent.setup().click(entry(new RegExp(copy.promoWhere)));
  const ledgerOpens = () =>
    navigations(http, 'Ledger').length + visitedLocations().filter((l) => l === '/ledger').length;
  // 经 nav.open 打开 Ledger 或站内进入 /ledger，只一次。
  await waitFor(() => expect(ledgerOpens()).toBe(1));
  // 人数本身不可点（BR-TEXT-14：人数取 direct_count，不可点）。
  expect(controls(new RegExp(copy.invitedUnit.replace('{n}', '7')))).toEqual([]);
  const others = http
    .calls('nav.open')
    .filter((request) => (request.params as { route?: string }).route !== 'Ledger');
  expect(others).toEqual([]);
});

it('[AC-F1-05a-LINK#2] 活动有效时【活动规则】与【完整规则】打开不同的帮助文章', async () => {
  const http = inviteServer({
    config: () => reply(config(inviteConfig({ enabled: true, amount_fen: 1000 }))),
  });
  mount(http.api);
  await screen.findAllByText(copy.rewardTitle, { exact: false });
  const user = userEvent.setup();
  await user.click(entry(/活动规则/));
  await waitFor(() => expect(openedHelpArticles(http)).toHaveLength(1));
  const reward = openedHelpArticles(http)[0]!;
  expect(reward).not.toBe('');
  // 测试路由不切换页面组件：站内跳转后邀请页仍在，可直接点第二个入口。
  await user.click(entry(new RegExp(copy.rulesFull)));
  await waitFor(() => expect(openedHelpArticles(http)).toHaveLength(2));
  const full = openedHelpArticles(http)[1]!;
  expect(full).not.toBe('');
  expect(full).not.toBe(reward);
});

it('[AC-F1-05a-LINK#3] 活动无效时【完整规则】打开邀请规则帮助文章，没有活动规则入口', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  expect(controls(/活动规则/)).toEqual([]);
  await userEvent.setup().click(entry(new RegExp(copy.rulesFull)));
  await waitFor(() => expect(openedHelpArticles(http)).toHaveLength(1));
  expect(openedHelpArticles(http)[0]).not.toBe('');
});
