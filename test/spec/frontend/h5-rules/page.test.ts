// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { articles, BODY_TEXT, CDN, reply, server, summaries } from './fixtures.ts';

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function mount(api: ReturnType<typeof server>['api']) {
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(createElement(RulesPage, { api, mediaCdnOrigin: CDN }), client),
  );
}

function paths(requests: Request[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

function entry(title: string): HTMLElement {
  const options = [
    ...screen.queryAllByRole('button', { name: title }),
    ...screen.queryAllByRole('link', { name: title }),
  ];
  expect(options, `唯一可访问入口 ${title}`).toHaveLength(1);
  return options[0]!;
}

it('[AC-F1-03a-PAGE#1] bridge 的 Rules 路由懒加载本页，不再使用占位页', async () => {
  const route = createAppRoutes().find((item) => item.path === bridge.routes.Rules.h5_path);
  expect(route).toBeDefined();
  const module = await route!.lazy();
  expect(module.Component).toBe(RulesPage);
});

it('[AC-F1-03a-PAGE#2] 先列表后详情各一次，按服务端首篇顺序显示标题、北京日期、正文及其他入口', async () => {
  const http = server();
  const view = mount(http.api);
  await screen.findByText(BODY_TEXT);
  expect(screen.getByRole('heading', { name: '返利规则', level: 1 })).toBeTruthy();
  expect(view.container.textContent).toMatch(/更新于\s*2026-10-01/);
  expect(view.container.textContent).not.toContain('更新于 2026-09-30');
  expect(paths(http.requests)).toEqual(['/v1/articles', '/v1/articles/z-rebate']);
  expect(new URL(http.requests[0]!.url).searchParams.get('category')).toBe('rule');
  expect(http.requests.every((request) => request.method === 'GET')).toBe(true);
  for (const title of ['提现规则', '订单找回']) {
    const control = entry(title);
    expect(
      screen.getByText(BODY_TEXT).compareDocumentPosition(control) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  }
});

it('[AC-F1-03a-PAGE#3] 点击底部入口页内切换全文，再通过首篇入口返回，不改变 URL', async () => {
  const http = server();
  const original = window.location.href;
  mount(http.api);
  await screen.findByText(BODY_TEXT);
  await userEvent.setup().click(entry('提现规则'));
  await screen.findByText('提现规则正文。');
  expect(screen.getByRole('heading', { name: '提现规则', level: 1 })).toBeTruthy();
  expect(screen.queryByText(BODY_TEXT)).toBeNull();
  expect(document.body.textContent).toMatch(/更新于\s*2026-10-02/);
  expect(paths(http.requests)).toEqual([
    '/v1/articles',
    '/v1/articles/z-rebate',
    '/v1/articles/a-withdrawal',
  ]);
  await userEvent.setup().click(entry('返利规则'));
  await screen.findByText(BODY_TEXT);
  expect(screen.queryByText('提现规则正文。')).toBeNull();
  expect(window.location.href).toBe(original);
  expect(paths(http.requests).filter((path) => path === '/v1/articles')).toHaveLength(1);
});

for (const stage of ['list', 'detail'] as const) {
  it(`[AC-F1-03a-PAGE#4] ${stage} 未完成时显示加载态，完成后移除`, async () => {
    const deferred = Promise.withResolvers<Response>();
    const http = server((url) => {
      if (url.pathname === '/v1/articles')
        return stage === 'list' ? deferred.promise : reply(summaries());
      return stage === 'detail' ? deferred.promise : reply(articles[0]);
    });
    const view = mount(http.api);
    await waitFor(() => expect(http.requests).toHaveLength(stage === 'list' ? 1 : 2));
    // Accept a semantic busy/status region or the existing shared Skeleton component.
    expect(
      view.container.querySelector(
        '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]',
      ),
    ).not.toBeNull();
    expect(screen.queryByText(BODY_TEXT)).toBeNull();
    await act(async () => {
      deferred.resolve(reply(stage === 'list' ? summaries() : articles[0]));
    });
    await screen.findByText(BODY_TEXT);
    expect(
      view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
    ).toBeNull();
    expect(paths(http.requests)).toEqual(['/v1/articles', '/v1/articles/z-rebate']);
  });
}

it('[AC-F1-03a-PAGE#5] 空列表显示空态，不请求不存在的详情', async () => {
  const http = server(() => reply({ items: [], next_cursor: null }));
  mount(http.api);
  await screen.findByText(/暂无.*规则|暂无内容/);
  expect(paths(http.requests)).toEqual(['/v1/articles']);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(BODY_TEXT)).toBeNull();
});

for (const stage of ['list', 'detail'] as const) {
  it(`[AC-F1-03a-PAGE#6] ${stage} 出错显示错误态，点击重试仅重发失败请求一次`, async () => {
    let failures = 0;
    const http = server((url) => {
      const isList = url.pathname === '/v1/articles';
      if (isList === (stage === 'list')) {
        failures += 1;
        if (failures === 1) return reply(null, 50001, 500);
      }
      return reply(isList ? summaries() : articles[0]);
    });
    mount(http.api);
    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/失败|出错|无法/);
    expect(failures).toBe(1);
    await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
    await screen.findByText(BODY_TEXT);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(failures).toBe(2);
    expect(paths(http.requests)).toEqual(
      stage === 'list'
        ? ['/v1/articles', '/v1/articles', '/v1/articles/z-rebate']
        : ['/v1/articles', '/v1/articles/z-rebate', '/v1/articles/z-rebate'],
    );
  });
}

for (const body of [
  '{invalid JSON',
  'null',
  '[]',
  '{"content":[]}',
  '{"type":"doc","content":"x"}',
]) {
  it(`[AC-F1-03a-PAGE#7] 详情正文 ${body} 非法时呈现错误态，其他规则仍可切换`, async () => {
    const http = server((url) =>
      reply(
        url.pathname === '/v1/articles'
          ? summaries()
          : url.pathname.endsWith('/z-rebate')
            ? { ...articles[0], body }
            : articles[1],
      ),
    );
    mount(http.api);
    expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
    expect(screen.getByRole('heading', { name: '返利规则', level: 1 })).toBeTruthy();
    await userEvent.setup().click(entry('提现规则'));
    await screen.findByText('提现规则正文。');
    expect(screen.queryByRole('alert')).toBeNull();
  });
}
