// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { list, message, messagesServer, reply, risk, tracked } from './messages-fixtures.ts';
import {
  LOADING,
  expectListQuery,
  mount,
  pullDown,
  reachBottom,
  settle,
} from './messages-helpers.ts';

it('[AC-F1-04c-PAGING#1] 滚到底携带原样游标追加下一页，在途不重复请求，无 next_cursor 不再请求', async () => {
  const cursor = 'next+/=消息';
  const pending = Promise.withResolvers<Response>();
  const second = message({ body: '第二页的消息', created_at: '2026-10-01T08:00:00+08:00' });
  const http = messagesServer({
    list: (url) =>
      url.searchParams.has('cursor') ? pending.promise : reply(list([tracked, risk], cursor)),
  });
  const view = mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  const target = screen.getByText(risk.body, { exact: false });
  reachBottom(target);
  reachBottom(target);
  await waitFor(() => expect(http.listRequests()).toHaveLength(2));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expectListQuery(http.listRequests()[0]!);
  expectListQuery(http.listRequests()[1]!, cursor);
  expect(http.listRequests()[1]!.headers.get('Authorization')).toBe('Bearer messages-token-1');
  await act(async () => {
    pending.resolve(reply(list([second])));
  });
  await screen.findByText(second.body, { exact: false });
  // 追加而不是替换：第一页仍在，且在第二页之前。
  const first = screen.getByText(tracked.body, { exact: false });
  expect(
    first.compareDocumentPosition(screen.getByText(second.body, { exact: false })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  reachBottom(screen.getByText(second.body, { exact: false }));
  await settle();
  expect(http.listRequests()).toHaveLength(2);
});

it('[AC-F1-04c-PAGING#2] 首页 next_cursor 为 null 时滚到底不请求', async () => {
  const http = messagesServer({ list: () => reply(list([tracked, risk], null)) });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  reachBottom(screen.getByText(risk.body, { exact: false }));
  await settle();
  expect(http.listRequests()).toHaveLength(1);
});

it('[AC-F1-04c-PAGING#3] 下拉刷新只重取第一页一次，丢弃旧页并使用新游标', async () => {
  const pending = Promise.withResolvers<Response>();
  const old = message({ body: '旧的第一页消息' });
  const oldSecond = message({ body: '旧的第二页消息' });
  const fresh = message({ body: '刷新后的第一页消息' });
  const freshSecond = message({ body: '刷新后的第二页消息' });
  const http = messagesServer({
    list: (_url, count) => {
      if (count === 1) return reply(list([old], 'old-cursor'));
      if (count === 2) return reply(list([oldSecond]));
      if (count === 3) return pending.promise;
      return reply(list([freshSecond]));
    },
  });
  mount(http.api);
  await screen.findByText(old.body, { exact: false });
  const target = screen.getByText(old.body, { exact: false });
  reachBottom(target);
  await screen.findByText(oldSecond.body, { exact: false });
  expectListQuery(http.listRequests()[1]!, 'old-cursor');
  pullDown(target);
  pullDown(target);
  await waitFor(() => expect(http.listRequests()).toHaveLength(3));
  expectListQuery(http.listRequests()[2]!);
  await act(async () => {
    pending.resolve(reply(list([fresh], 'new-cursor')));
  });
  await screen.findByText(fresh.body, { exact: false });
  await settle();
  // 刷新只新增一次首页请求，不重取已加载的后续页。
  expect(http.listRequests()).toHaveLength(3);
  expect(screen.queryByText(old.body, { exact: false })).toBeNull();
  expect(screen.queryByText(oldSecond.body, { exact: false })).toBeNull();
  reachBottom(screen.getByText(fresh.body, { exact: false }));
  await screen.findByText(freshSecond.body, { exact: false });
  expect(http.listRequests()).toHaveLength(4);
  expectListQuery(http.listRequests()[3]!, 'new-cursor');
});

it('[AC-F1-04c-PAGING#4] 下拉刷新与翻页都不调标已读，也不读列表以外的接口（不读注销状态）', async () => {
  const http = messagesServer({
    list: (url) =>
      url.searchParams.has('cursor')
        ? reply(list([message({ body: '更早的消息' })]))
        : reply(list([tracked], 'c2')),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  reachBottom(screen.getByText(tracked.body, { exact: false }));
  await screen.findByText('更早的消息', { exact: false });
  pullDown(screen.getByText(tracked.body, { exact: false }));
  await waitFor(() => expect(http.listRequests()).toHaveLength(3));
  await settle();
  expect(http.readRequests()).toEqual([]);
  const paths = http.requests.map((request) => new URL(request.url).pathname);
  expect(new Set(paths)).toEqual(new Set(['/v1/messages']));
});
