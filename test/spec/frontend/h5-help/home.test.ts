// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { articles, appApi, fakeBridge, helpServer, reply, summaries } from './fixtures.ts';
import { entry, expectListQuery, mount, paths } from './helpers.ts';

it('[AC-F1-03b-HOME#1] 匿名列表只请求一次 category=help，按服务端顺序呈现三个常见问题和客服卡片', async () => {
  const http = helpServer();
  const native = fakeBridge();
  mount(appApi(http, native), { bridge: native.bridge });
  await screen.findByText(articles[2]!.title);
  expect(screen.getByRole('heading', { name: '帮助中心' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '常见问题' })).toBeTruthy();
  const controls = articles.map((article) => entry(article.title));
  for (let index = 1; index < controls.length; index += 1) {
    expect(
      controls[index - 1]!.compareDocumentPosition(controls[index]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  }
  expect(paths(http.requests)).toEqual(['/v1/articles']);
  expectListQuery(http.requests[0]!);
  expect(http.requests[0]!.headers.has('Authorization')).toBe(false);
  expect(http.requests[0]!.headers.has('X-Device-Id')).toBe(false);
  expect(native.getToken).not.toHaveBeenCalled();
  expect(native.authenticatedRequest).not.toHaveBeenCalled();
  expect(screen.getByText(/没找到答案/)).toBeTruthy();
  expect(entry('联系客服')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  expect(screen.queryByRole('link', { name: '新手教程' })).toBeNull();
});

it('[AC-F1-03b-HOME#2] 换一组后台标题和编号仍全部展示，点击请求该编号而非内置常见问题', async () => {
  const changed = articles
    .map((article, index) => ({
      ...article,
      article_id: `cms-revised-${index}`,
      title: `运营刚发布的问题 ${index + 1}`,
    }))
    .reverse();
  const http = helpServer((url) =>
    url.pathname === '/v1/articles' ? reply(summaries(changed)) : reply(changed[0]),
  );
  mount(http.api);
  await screen.findByText(changed[2]!.title);
  for (const article of changed) expect(entry(article.title)).toBeTruthy();
  for (const article of articles) expect(screen.queryByText(article.title)).toBeNull();
  await userEvent.setup().click(entry(changed[0]!.title));
  await screen.findByRole('heading', { name: changed[0]!.title, level: 1 });
  expect(paths(http.requests)).toEqual(['/v1/articles', '/v1/articles/cms-revised-2']);
});

it('[AC-F1-03b-HOME#3] 仅点击加载更多才使用原样游标追加下一页，末页移除入口', async () => {
  const cursor = 'opaque+/=页2';
  const pending = Promise.withResolvers<Response>();
  const http = helpServer((url) =>
    url.searchParams.has('cursor')
      ? pending.promise
      : reply(summaries(articles.slice(0, 2), cursor)),
  );
  mount(http.api);
  await screen.findByText(articles[1]!.title);
  expect(http.requests).toHaveLength(1);
  expect(screen.queryByText(articles[2]!.title)).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(http.requests).toHaveLength(2));
  expectListQuery(http.requests[0]!);
  expectListQuery(http.requests[1]!, cursor);
  expect(entry(articles[0]!.title)).toBeTruthy();
  await act(async () => {
    pending.resolve(reply(summaries(articles.slice(2))));
  });
  await screen.findByText(articles[2]!.title);
  const controls = articles.map((article) => entry(article.title));
  expect(
    controls[1]!.compareDocumentPosition(controls[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  expect(http.requests).toHaveLength(2);
});

it('[AC-F1-03b-HOME#4] 首次请求未完成显示加载态，成功后显示列表并移除加载态', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = helpServer(() => pending.promise);
  const view = mount(http.api);
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(
    view.container.querySelector(
      '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]',
    ),
  ).not.toBeNull();
  expect(screen.queryByText(articles[0]!.title)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => {
    pending.resolve(reply(summaries()));
  });
  await screen.findByText(articles[0]!.title);
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
  expect(http.requests).toHaveLength(1);
});

it('[AC-F1-03b-HOME#5] 空列表提示暂无内容，仍保留联系客服且不请求详情', async () => {
  const http = helpServer(() => reply(summaries([])));
  mount(http.api);
  await screen.findByText(/暂无.*(?:帮助|问题|内容)|还没有.*(?:帮助|问题|内容)/);
  expect(entry('联系客服')).toBeTruthy();
  expect(screen.getByText(/没找到答案/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
  expect(paths(http.requests)).toEqual(['/v1/articles']);
});

it('[AC-F1-03b-HOME#6] 请求失败显示出错态，手动重试只再请求一次', async () => {
  const http = helpServer((_url, count) =>
    count === 1 ? reply(null, 50001, 500) : reply(summaries()),
  );
  mount(http.api);
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(articles[0]!.title);
  expect(paths(http.requests)).toEqual(['/v1/articles', '/v1/articles']);
  for (const request of http.requests) expectListQuery(request);
  expect(screen.queryByRole('alert')).toBeNull();
});

for (const [index, url] of ['/help', '/help?article_id=z-faq-47'].entries()) {
  it(`[AC-F1-03b-HOME#${7 + index}] ${url} 无可用 useApi 时显示错误或占位，不发请求`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const view = mount(null, { url, bridge: fakeBridge({ inApp: false }).bridge });
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/失败|无法|暂未|未配置|App|应用|稍后|尚未/),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(articles[0]!.title)).toBeNull();
    expect(
      view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
    ).toBeNull();
  });
}
