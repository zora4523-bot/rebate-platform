// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { LOADING, mount } from './helpers.ts';
import { AGREEMENT_BODY, agreements, reply, server, urls } from './fixtures.ts';

for (const [index, article] of agreements.entries()) {
  it(`[AC-F1-03c-AGREEMENT#${index + 1}] ${article.article_id} 匿名读取对应协议，标题、版本、北京日期和正文来自接口`, async () => {
    const http = server();
    const view = mount(http.api, `/agreement?type=${article.article_id}`);
    expect(await screen.findByRole('heading', { name: article.title, level: 1 })).toBeTruthy();
    expect(view.container.textContent).toMatch(/版本\s*7/);
    expect(view.container.textContent).toMatch(/更新日期\s*2026-10-01/);
    expect(screen.getByText(AGREEMENT_BODY).tagName).toBe('P');
    expect(urls(http.requests)).toEqual([`/v1/articles/${article.article_id}`]);
    expect(http.requests[0]!.method).toBe('GET');
    expect(http.requests[0]!.headers.has('Authorization')).toBe(false);
  });
}

for (const [index, query] of [
  '',
  '?type=arbitrary/../../unsafe?x=1',
  '?type=',
  '?type=Privacy',
].entries()) {
  it(`[AC-F1-03c-AGREEMENT#${4 + index}] 缺省或非法 type ${query} 固定回退 agreement，不拼接任意路径`, async () => {
    const http = server();
    mount(http.api, `/agreement${query}`);
    expect(
      await screen.findByRole('heading', { name: agreements[0]!.title, level: 1 }),
    ).toBeTruthy();
    expect(urls(http.requests)).toEqual(['/v1/articles/agreement']);
  });
}

it('[AC-F1-03c-AGREEMENT#8] 30701 显示协议暂未发布空态，不请求协议列表或其他版本', async () => {
  const http = server(() => reply(null, 30701, 404));
  mount(http.api, '/agreement?type=privacy');
  expect(await screen.findByText('协议暂未发布')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(urls(http.requests)).toEqual(['/v1/articles/privacy']);
});

it('[AC-F1-03c-AGREEMENT#9] 协议其他错误可重试一次，始终不请求列表', async () => {
  const http = server((_url, count) =>
    count === 1 ? reply(null, 50001, 500) : reply(agreements[1]),
  );
  mount(http.api, '/agreement?type=privacy');
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  expect(await screen.findByText(AGREEMENT_BODY)).toBeTruthy();
  expect(urls(http.requests)).toEqual(['/v1/articles/privacy', '/v1/articles/privacy']);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('[AC-F1-03c-AGREEMENT#10] 加载协议时有加载态，收到后移除', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = server(() => pending.promise);
  const view = mount(http.api, '/agreement');
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(screen.queryByText('协议暂未发布')).toBeNull();
  await act(async () => {
    pending.resolve(reply(agreements[0]));
  });
  expect(await screen.findByText(AGREEMENT_BODY)).toBeTruthy();
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

it('[AC-F1-03c-AGREEMENT#13] 同页更换 type 按新协议请求并更新标题', async () => {
  const http = server();
  const view = mount(http.api, '/agreement?type=privacy');
  await screen.findByRole('heading', { name: agreements[1]!.title, level: 1 });
  await view.go('/agreement?type=sdk_list');
  expect(await screen.findByRole('heading', { name: agreements[2]!.title, level: 1 })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: agreements[1]!.title, level: 1 })).toBeNull();
  expect(urls(http.requests)).toEqual(['/v1/articles/privacy', '/v1/articles/sdk_list']);
});

it('[AC-F1-03c-AGREEMENT#14] 协议正文解析失败显示错误态', async () => {
  const http = server(() => reply({ ...agreements[0], body: '{broken' }));
  mount(http.api, '/agreement');
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(screen.queryByText('{broken')).toBeNull();
  expect(urls(http.requests)).toEqual(['/v1/articles/agreement']);
});

for (const [index, path] of [
  '/notice',
  '/notice?article_id=z-maintenance',
  '/agreement?type=privacy',
].entries()) {
  it(`[AC-F1-03c-AGREEMENT#${15 + index}] ${path} 没有 useApi 客户端时显示反馈且不发请求`, async () => {
    const fetch = vi.fn(() => Promise.resolve(reply(null, 50001, 500)));
    vi.stubGlobal('fetch', fetch);
    const view = mount(null, path);
    await waitFor(() =>
      expect(view.container.textContent).toMatch(/失败|出错|无法|尚未|暂未|未开放|未开通|未上线/),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(AGREEMENT_BODY)).toBeNull();
  });
}
