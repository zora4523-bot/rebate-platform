// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  coolingError,
  coolingOff,
  list,
  message,
  messagesServer,
  paid,
  reply,
  risk,
  texts,
  tracked,
} from './messages-fixtures.ts';
import {
  announcesUnread,
  entry,
  mount,
  pullDown,
  reachBottom,
  rowFor,
  settle,
} from './messages-helpers.ts';

function readAllButton(): HTMLElement {
  return screen.getByRole('button', { name: texts.readAll });
}

it('[AC-F1-04c-READALL#1] 「全部已读」以 {all:true} 标已读，回包后所有未读状态消失', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, paid, risk])),
    read: () => reply({ marked_count: 2, unread_count: 0 }),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  const button = await screen.findByRole('button', { name: texts.readAll });
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(announcesUnread(rowFor(risk.body))).toBe(true);
  await userEvent.setup().click(button);
  await waitFor(() => expect(http.reads).toHaveLength(1));
  // 请求体恰为 {all:true}，不是把已加载的未读编号列出来。
  expect(http.reads[0]).toStrictEqual({ all: true });
  await waitFor(() => {
    for (const item of [tracked, paid, risk])
      expect(announcesUnread(rowFor(item.body))).toBe(false);
  });
  await settle();
  expect(http.reads).toHaveLength(1);
  expect(http.navigation()).toEqual([]);
});

it('[AC-F1-04c-READALL#2] 已翻过页时「全部已读」仍只发一次 {all:true}，未加载的消息也算在内', async () => {
  const older = message({ body: '第二页的消息', created_at: '2026-10-01T08:00:00+08:00' });
  const http = messagesServer({
    list: (url) =>
      url.searchParams.has('cursor')
        ? reply(list([older], 'page-3'))
        : reply(list([tracked, risk], 'page-2')),
    read: () => reply({ marked_count: 5, unread_count: 0 }),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  reachBottom(screen.getByText(risk.body, { exact: false }));
  await screen.findByText(older.body, { exact: false });
  await userEvent.setup().click(await screen.findByRole('button', { name: texts.readAll }));
  await waitFor(() => expect(http.reads).toHaveLength(1));
  await settle();
  expect(http.reads).toStrictEqual([{ all: true }]);
  for (const item of [tracked, risk, older]) expect(announcesUnread(rowFor(item.body))).toBe(false);
});

it('[AC-F1-04c-READALL#3] 注销冷静期（D10-542）：「全部已读」回 10007 后按钮消失、不弹错、未读不变，此后不再标已读', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, paid, risk])),
    read: () => coolingOff(),
  });
  const view = mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: texts.readAll }));
  await waitFor(() => expect(http.reads).toStrictEqual([{ all: true }]));
  await waitFor(() => expect(screen.queryByRole('button', { name: texts.readAll })).toBeNull());
  await settle();
  expect(screen.queryByText(texts.readAll, { exact: false })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(view.container.textContent).not.toContain(coolingError);
  expect(document.body.textContent).not.toContain(coolingError);
  // 什么都没标成已读：未读 / 已读状态与进页时一致。
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(announcesUnread(rowFor(risk.body))).toBe(true);
  expect(announcesUnread(rowFor(paid.body))).toBe(false);
  // 之后点开有 route 的未读消息：照常跳转，不再调标已读。
  await user.click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(1));
  await settle();
  expect(http.readRequests()).toHaveLength(1);
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(http.deletionRequests()).toEqual([]);
});

it('[AC-F1-04c-READALL#4] 不预判冷静期（D10-542）：进页即显示「全部已读」，从不请求 GET /v1/me/deletion', async () => {
  const http = messagesServer({ list: () => reply(list([tracked])) });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  expect(await screen.findByRole('button', { name: texts.readAll })).toBeTruthy();
  await settle();
  expect(screen.getByRole('button', { name: texts.readAll })).toBeTruthy();
  expect(http.deletionRequests()).toEqual([]);
  expect(http.readRequests()).toEqual([]);
});

it('[AC-F1-04c-READALL#5] 回过 10007 后下拉刷新：「全部已读」仍不出现，也不再标已读', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, risk])),
    read: () => coolingOff(),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await userEvent.setup().click(await screen.findByRole('button', { name: texts.readAll }));
  await waitFor(() => expect(http.reads).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: texts.readAll })).toBeNull());
  pullDown(screen.getByText(tracked.body, { exact: false }));
  await waitFor(() => expect(http.listRequests()).toHaveLength(2));
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  expect(screen.queryByRole('button', { name: texts.readAll })).toBeNull();
  expect(http.readRequests()).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(http.deletionRequests()).toEqual([]);
});

it('[AC-F1-04c-READALL#6] 「全部已读」失败不弹错，列表照常浏览', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, paid])),
    read: () => reply(null, 50001, 500),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await userEvent.setup().click(await screen.findByRole('button', { name: texts.readAll }));
  await waitFor(() => expect(http.reads).toHaveLength(1));
  await settle();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(tracked.body, { exact: false })).toBeTruthy();
  expect(screen.getByText(paid.body, { exact: false })).toBeTruthy();
  expect(readAllButton()).toBeTruthy();
});
