// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { list, messagesServer, reply, texts, tracked } from './messages-fixtures.ts';
import { LOADING, mount, settle } from './messages-helpers.ts';

it('[AC-F1-04c-STATES#1] 首屏请求在途显示加载态，不显示空态或错误；完成后才显示消息', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = messagesServer({ list: () => pending.promise });
  const view = mount(http.api);
  await waitFor(() => expect(http.listRequests()).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(screen.queryByText(texts.empty, { exact: false })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(list([tracked])));
  });
  await screen.findByText(tracked.body, { exact: false });
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-04c-STATES#2] 没有消息时显示字典空态两句，不出现错误态', async () => {
  const http = messagesServer({ list: () => reply(list([])) });
  mount(http.api);
  expect(await screen.findByText(texts.empty, { exact: false })).toBeTruthy();
  expect(screen.getByText(texts.emptyHint, { exact: false })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await settle();
  expect(http.listRequests()).toHaveLength(1);
  expect(http.readRequests()).toEqual([]);
});

it('[AC-F1-04c-STATES#3] 首屏失败显示 h5.load_failed，点重试只再请求一次列表', async () => {
  const http = messagesServer({
    list: (_url, count) => (count === 1 ? reply(null, 50001, 500) : reply(list([tracked]))),
  });
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toContain(texts.loadFailed);
  expect(http.listRequests()).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(tracked.body, { exact: false });
  expect(http.listRequests()).toHaveLength(2);
  expect(http.listRequests()[1]!.url).toBe(http.listRequests()[0]!.url);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-04c-STATES#4] 断网（请求未到达服务端）显示错误态并可重试', async () => {
  let failures = 0;
  const http = messagesServer({
    list: (_url, count) => {
      if (count === 1) {
        failures += 1;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return reply(list([tracked]));
    },
  });
  mount(http.api);
  const alert = await screen.findByRole('alert');
  expect(failures).toBe(1);
  // 网络错误态：h5.load_failed 或 error.50001（占位符前的句子），二者之一。
  const offline = texts.offline.split('（')[0]!;
  expect(
    alert.textContent!.includes(texts.loadFailed) || alert.textContent!.includes(offline),
  ).toBe(true);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(tracked.body, { exact: false });
  expect(http.listRequests()).toHaveLength(2);
});

it('[AC-F1-04c-STATES#5] 10405 显示错误态且列表请求只发一次，不自动重放', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00+08:00'));
  const http = messagesServer({ list: () => reply(null, 10405, 403) });
  mount(http.api);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toMatch(
    new RegExp(`${texts.loadFailed}|${dictionary.texts['error.10405']}`),
  );
  await act(async () => {});
  expect(http.listRequests()).toHaveLength(1);
  expect(screen.queryByText(texts.empty, { exact: false })).toBeNull();
});

it('[AC-F1-04c-STATES#6] 没有 App API 客户端（App 外）时不发请求、不抛错', async () => {
  const http = messagesServer();
  const view = mount(null);
  await settle();
  expect(http.requests).toEqual([]);
  expect(view.container.textContent).not.toMatch(/null|undefined|NotImplemented/);
});
