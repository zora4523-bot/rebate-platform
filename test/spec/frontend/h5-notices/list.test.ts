// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { entry, LOADING, mount } from './helpers.ts';
import { list, NOTICE_BODY, notices, reply, server } from './fixtures.ts';

it('[AC-F1-03c-NOTICE-LIST#1] 仅请求公告分类，按服务端顺序显示标题、NoticeItem 摘要和北京日期', async () => {
  const http = server();
  mount(http.api);
  await screen.findByText(notices[0]!.notice.text);
  expect(screen.getByText(notices[1]!.notice.text)).toBeTruthy();
  expect(screen.getByText('2026-10-01')).toBeTruthy();
  expect(screen.getByText('2026-09-29')).toBeTruthy();
  expect(screen.queryByText('2026-09-30')).toBeNull();
  expect(screen.queryByText(NOTICE_BODY)).toBeNull();
  expect(
    entry(/订单同步维护通知/).compareDocumentPosition(entry(/国庆期间客服时间调整/)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(http.requests).toHaveLength(1);
  const request = http.requests[0]!;
  const url = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(request.headers.has('Authorization')).toBe(false);
  expect(url.pathname).toBe('/v1/articles');
  expect(url.searchParams.getAll('category')).toEqual(['notice']);
  expect(url.searchParams.has('cursor')).toBe(false);
  expect(
    [...url.searchParams.keys()].filter((key) => !['category', 'limit'].includes(key)),
  ).toEqual([]);
  if (url.searchParams.has('limit')) {
    const limit = Number(url.searchParams.get('limit'));
    expect(Number.isInteger(limit) && limit >= 1 && limit <= 50).toBe(true);
  }
  expect(screen.getByText('没有更多公告了')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
});

it('[AC-F1-03c-NOTICE-LIST#2] 点击加载更多传游标并追加，在途双击只发一次', async () => {
  const cursor = 'next+/=公告';
  const pending = Promise.withResolvers<Response>();
  const http = server((url) =>
    url.searchParams.has('cursor') ? pending.promise : reply(list([notices[0]!], cursor)),
  );
  mount(http.api);
  await screen.findByText(notices[0]!.notice.text);
  expect(http.requests).toHaveLength(1);
  expect(screen.queryByText('没有更多公告了')).toBeNull();
  expect(screen.queryByText(notices[1]!.title)).toBeNull();
  const more = screen.getByRole('button', { name: /加载更多/ });
  // Same-turn clicks exercise the gap before a React rerender disables the button.
  act(() => {
    fireEvent.click(more);
    fireEvent.click(more);
  });
  await waitFor(() => expect(http.requests).toHaveLength(2));
  const next = new URL(http.requests[1]!.url);
  expect(next.searchParams.get('cursor')).toBe(cursor);
  expect(next.searchParams.get('category')).toBe('notice');
  expect(next.pathname).toBe('/v1/articles');
  expect(
    [...next.searchParams.keys()].filter((key) => !['category', 'cursor', 'limit'].includes(key)),
  ).toEqual([]);
  await act(async () => {
    pending.resolve(reply(list([notices[1]!])));
  });
  await screen.findByText(notices[1]!.notice.text);
  expect(screen.getByText(notices[0]!.notice.text)).toBeTruthy();
  expect(
    entry(/订单同步维护通知/).compareDocumentPosition(entry(/国庆期间客服时间调整/)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(screen.getByText('没有更多公告了')).toBeTruthy();
  expect(http.requests).toHaveLength(2);
});

it('[AC-F1-03c-NOTICE-LIST#3] 首屏请求未完成显示加载态，数据到达后移除', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = server(() => pending.promise);
  const view = mount(http.api);
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(screen.queryByText('暂无公告')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(list()));
  });
  await screen.findByText(notices[0]!.notice.text);
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-03c-NOTICE-LIST#4] 空列表显示暂无公告且不请求详情', async () => {
  const http = server(() => reply(list([])));
  mount(http.api);
  expect(await screen.findByText('暂无公告')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(http.requests).toHaveLength(1);
  expect(new URL(http.requests[0]!.url).pathname).toBe('/v1/articles');
});

it('[AC-F1-03c-NOTICE-LIST#5] 请求出错不自动重试，手动重试只增加一次请求', async () => {
  const http = server((_url, count) => (count === 1 ? reply(null, 50001, 500) : reply(list())));
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(notices[0]!.notice.text);
  expect(http.requests).toHaveLength(2);
  expect(http.requests[1]!.url).toBe(http.requests[0]!.url);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-03c-NOTICE-LIST#6] 下一页出错保留已有条目，重试仍请求失败游标且不重复追加', async () => {
  let nextCalls = 0;
  const http = server((url) => {
    if (!url.searchParams.has('cursor')) return reply(list([notices[0]!], 'page-two'));
    nextCalls += 1;
    return nextCalls === 1 ? reply(null, 50001, 500) : reply(list([notices[1]!]));
  });
  mount(http.api);
  await screen.findByText(notices[0]!.notice.text);
  await userEvent.setup().click(screen.getByRole('button', { name: /加载更多/ }));
  await screen.findByRole('alert');
  expect(screen.getByText(notices[0]!.notice.text)).toBeTruthy();
  expect(nextCalls).toBe(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(notices[1]!.notice.text);
  expect(screen.getAllByText(notices[0]!.notice.text)).toHaveLength(1);
  expect(http.requests).toHaveLength(3);
  expect(http.requests[2]!.url).toBe(http.requests[1]!.url);
  expect(nextCalls).toBe(2);
});
