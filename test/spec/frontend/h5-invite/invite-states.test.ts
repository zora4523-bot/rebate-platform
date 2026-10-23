// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  config,
  copy,
  inviteCode,
  inviteConfig,
  inviteServer,
  myInvite,
  reply,
  unavailable,
} from './invite-fixtures.ts';
import { LOADING, controls, mount, pageText, squash } from './invite-helpers.ts';

const COPY_CODE = /复制邀请码/;
const COPY_LINK = /复制邀请链接/;
const SAVE_POSTER = /保存海报/;
const SHARE = /分享/;
const RETRY = /重试|重新加载/;

function expectNoInviteEntries(): void {
  for (const name of [COPY_CODE, COPY_LINK, SAVE_POSTER, SHARE]) {
    expect(controls(name), `不应出现入口 ${String(name)}`).toEqual([]);
  }
}

it('[AC-F1-05a-STATES#1] 请求在途显示加载态，返回后才显示邀请码', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = inviteServer({ invite: () => pending.promise });
  const view = mount(http.api);
  await waitFor(() => expect(http.inviteRequests()).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(squash(view.container.textContent)).not.toContain(inviteCode);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(myInvite()));
  });
  await screen.findAllByText(inviteCode, { exact: false });
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-05a-STATES#2] 应用级客户端取 H5 令牌后 GET /v1/invites/me，带 Bearer 且无查询参数', async () => {
  const http = inviteServer();
  mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const requests = http.inviteRequests();
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('GET');
  expect(new URL(request.url).search).toBe('');
  expect(http.tokenCalls()).toBe(1);
  expect(request.headers.get('Authorization')).toBe('Bearer invite-token-1');
});

it('[AC-F1-05a-STATES#3] 可邀请：邀请码卡（邀请码与三个按钮）、人数卡与邀请规则卡', async () => {
  const http = inviteServer({ invite: () => reply(myInvite({ direct_count: 7 })) });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  expect(controls(COPY_CODE)).toHaveLength(1);
  expect(controls(COPY_LINK)).toHaveLength(1);
  expect(controls(SAVE_POSTER)).toHaveLength(1);
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.invitedCount));
  expect(text).toContain(squash(copy.invitedUnit.replace('{n}', '7')));
  expect(text).toContain(squash(copy.rulesTitle));
  expect(text).not.toContain(squash(copy.unavailable));
  expect(text).not.toMatch(/null|undefined|NaN|\{n\}/);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-05a-STATES#4] 直邀人数按 direct_count 显示，0 人也照常显示', async () => {
  const http = inviteServer({ invite: () => reply(myInvite({ direct_count: 0 })) });
  const view = mount(http.api);
  await screen.findAllByText(inviteCode, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.invitedCount));
  expect(text).toContain(squash(copy.invitedUnit.replace('{n}', '0')));
  expect(text).not.toContain(squash(copy.invitedUnit.replace('{n}', '7')));
});

it('[AC-F1-05a-STATES#5] can_invite=false：暂不可邀请说明不给原因，人数卡照常，无邀请码卡与按钮', async () => {
  const http = inviteServer({ invite: () => reply(unavailable) });
  const view = mount(http.api);
  await screen.findAllByText(copy.unavailable, { exact: false });
  const text = pageText(view.container);
  expect(text).toContain(squash(copy.unavailableHint));
  expect(text).toContain(squash(copy.invitedCount));
  expect(text).toContain(squash(copy.invitedUnit.replace('{n}', '4')));
  expectNoInviteEntries();
  // 不展示原因（BR-INV-18 细则：其他不可用情形不展示原因）。
  expect(text).not.toContain(squash(copy.minor));
  expect(text).not.toMatch(/封禁|null|undefined|NaN/);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-05a-STATES#6] 30413：显示 error.30413，隐藏邀请与分享入口，不重试', async () => {
  const http = inviteServer({
    invite: () => reply({ reason: 'self_minor' }, 30413, 403),
    config: () => reply(config(inviteConfig({ enabled: true, amount_fen: 1000 }))),
  });
  const view = mount(http.api);
  await screen.findAllByText(copy.minor, { exact: false });
  expectNoInviteEntries();
  const text = pageText(view.container);
  expect(text).not.toContain(inviteCode);
  // BR-INV-19 细则：30413 时奖励活动卡不在任何位置显示。
  expect(text).not.toContain(squash(copy.rewardTitle));
  expect(controls(/活动规则/)).toEqual([]);
  await act(async () => {});
  expect(http.inviteRequests()).toHaveLength(1);
});

it('[AC-F1-05a-STATES#7] 10005：兜底显示 error.10005，无邀请入口', async () => {
  const http = inviteServer({ invite: () => reply(null, 10005, 403) });
  const view = mount(http.api);
  await screen.findAllByText(copy.needPhone, { exact: false });
  expectNoInviteEntries();
  expect(pageText(view.container)).not.toContain(squash(copy.minor));
  await act(async () => {});
  expect(http.inviteRequests()).toHaveLength(1);
});

it('[AC-F1-05a-STATES#8] 加载失败显示 H5 失败文案，点重试只再请求一次 getMyInvite', async () => {
  const http = inviteServer({
    invite: (count) => (count === 1 ? reply(null, 50001, 500) : reply(myInvite())),
  });
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toContain(copy.loadFailed);
  expect(http.inviteRequests()).toHaveLength(1);
  expectNoInviteEntries();
  await userEvent.setup().click(screen.getByRole('button', { name: RETRY }));
  await screen.findAllByText(inviteCode, { exact: false });
  expect(http.inviteRequests()).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-05a-STATES#9] 断网显示错误态与重试，恢复后重试成功', async () => {
  const http = inviteServer({
    invite: (count) =>
      count === 1 ? Promise.reject(new TypeError('Failed to fetch')) : reply(myInvite()),
  });
  mount(http.api);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent?.trim()).not.toBe('');
  expect(alert.textContent).not.toMatch(/TypeError|Failed to fetch/);
  expectNoInviteEntries();
  await userEvent.setup().click(screen.getByRole('button', { name: RETRY }));
  await screen.findAllByText(inviteCode, { exact: false });
  expect(http.inviteRequests()).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-05a-STATES#10] 10405 显示错误态且 getMyInvite 只发一次，不自动重放', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const http = inviteServer({ invite: () => reply(null, 10405, 403) });
  mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(new RegExp(`${copy.loadFailed}|${copy.outdated}`));
  await act(async () => {});
  expect(http.inviteRequests()).toHaveLength(1);
  expectNoInviteEntries();
});
