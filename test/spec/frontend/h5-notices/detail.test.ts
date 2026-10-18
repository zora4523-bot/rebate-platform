// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { entry, LOADING, mount } from './helpers.ts';
import {
  CDN,
  defaultReply,
  NOTICE_BODY,
  noticeArticle,
  notices,
  reply,
  server,
  urls,
} from './fixtures.ts';

const detailPath = '/notice?article_id=z-maintenance';

it('[AC-F1-03c-NOTICE-DETAIL#1] 请求指定详情一次，显示 h1、北京时间和正文', async () => {
  const http = server();
  const view = mount(http.api, detailPath);
  expect(await screen.findByRole('heading', { name: noticeArticle.title, level: 1 })).toBeTruthy();
  expect(view.container.textContent).toMatch(/凑狸\s*·\s*2026-09-29 00:15/);
  expect(screen.getByText(NOTICE_BODY).tagName).toBe('P');
  expect(urls(http.requests)).toEqual(['/v1/articles/z-maintenance']);
  expect(http.requests[0]!.method).toBe('GET');
  expect(http.requests[0]!.headers.has('Authorization')).toBe(false);
});

it('[AC-F1-03c-NOTICE-DETAIL#2] 30701 显示公告下线空态，点击返回列表可读其他公告', async () => {
  const http = server((url) =>
    url.pathname === '/v1/articles' ? defaultReply(url) : reply(null, 30701, 404),
  );
  mount(http.api, detailPath);
  expect(await screen.findByText('公告不存在或已下线')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(entry(/返回.*列表/));
  await screen.findByText(notices[0]!.notice.text);
  expect(screen.getByTestId('location').textContent).toBe('/notice');
  expect(urls(http.requests).map((url) => url.split('?')[0])).toEqual([
    '/v1/articles/z-maintenance',
    '/v1/articles',
  ]);
});

it('[AC-F1-03c-NOTICE-DETAIL#3] 其他错误显示出错态，重试只再请求此详情一次', async () => {
  const http = server((_url, count) =>
    count === 1 ? reply(null, 50001, 500) : reply(noticeArticle),
  );
  mount(http.api, detailPath);
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  expect(await screen.findByText(NOTICE_BODY)).toBeTruthy();
  expect(urls(http.requests)).toEqual(['/v1/articles/z-maintenance', '/v1/articles/z-maintenance']);
  expect(screen.queryByRole('alert')).toBeNull();
});

for (const [index, invalidBody] of [
  '{broken',
  'null',
  '{"type":"doc","content":"wrong"}',
].entries()) {
  it(`[AC-F1-03c-NOTICE-DETAIL#${4 + index}] 正文解析失败显示错误态，不显示原始 JSON`, async () => {
    const http = server(() => reply({ ...noticeArticle, body: invalidBody }));
    mount(http.api, detailPath);
    expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
    expect(screen.queryByText(invalidBody)).toBeNull();
    expect(http.requests).toHaveLength(1);
  });
}

it('[AC-F1-03c-NOTICE-DETAIL#7] 未完成显示加载态，完成后正文替换加载态', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = server(() => pending.promise);
  const view = mount(http.api, detailPath);
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(view.container.querySelector(LOADING)).not.toBeNull();
  expect(screen.queryByText('公告不存在或已下线')).toBeNull();
  await act(async () => {
    pending.resolve(reply(noticeArticle));
  });
  expect(await screen.findByText(NOTICE_BODY)).toBeTruthy();
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
});

for (const [index, id] of ['x', 'x'.repeat(64), '公告/a?b#c% &'].entries()) {
  it(`[AC-F1-03c-NOTICE-DETAIL#${8 + index}] 合法 article_id 长度边界与保留字符安全编码`, async () => {
    const http = server(() => reply({ ...noticeArticle, article_id: id }));
    mount(http.api, `/notice?article_id=${encodeURIComponent(id)}`);
    expect(await screen.findByText(NOTICE_BODY)).toBeTruthy();
    expect(urls(http.requests)).toEqual([`/v1/articles/${encodeURIComponent(id)}`]);
  });
}

it('[AC-F1-03c-NOTICE-DETAIL#11] 空 article_id 显示列表或无效态，不请求详情', async () => {
  const http = server();
  const view = mount(http.api, '/notice?article_id=');
  await waitFor(() => {
    const showsList = screen.queryByText(notices[0]!.notice.text) !== null;
    const showsInvalid = /公告不存在或已下线|失败|出错|无效/.test(view.container.textContent ?? '');
    expect(showsList || showsInvalid).toBe(true);
  });
  expect(http.requests.every((request) => new URL(request.url).pathname === '/v1/articles')).toBe(
    true,
  );
  expect(screen.queryByText(NOTICE_BODY)).toBeNull();
});

it('[AC-F1-03c-NOTICE-DETAIL#12] 65 字符 article_id 不请求接口，提供可见反馈', async () => {
  const http = server();
  const view = mount(http.api, `/notice?article_id=${'x'.repeat(65)}`);
  await waitFor(() =>
    expect(view.container.textContent).toMatch(/公告不存在或已下线|失败|出错|无效/),
  );
  expect(http.requests).toHaveLength(0);
  expect(screen.queryByText(NOTICE_BODY)).toBeNull();
});

it('[AC-F1-03c-NOTICE-DETAIL#13] 查询参数换文章时不沿用旧正文，晚到的旧响应不能覆盖新文章', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = server((url) =>
    url.pathname.endsWith('/z-maintenance')
      ? pending.promise
      : reply({
          ...noticeArticle,
          article_id: 'a-service',
          title: notices[1]!.title,
          body: JSON.stringify({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二篇正文' }] }],
          }),
        }),
  );
  const view = mount(http.api, detailPath);
  await waitFor(() => expect(http.requests).toHaveLength(1));
  await view.go('/notice?article_id=a-service');
  await screen.findByText('第二篇正文');
  await act(async () => {
    pending.resolve(reply(noticeArticle));
  });
  expect(screen.getByRole('heading', { name: notices[1]!.title, level: 1 })).toBeTruthy();
  expect(screen.queryByText(NOTICE_BODY)).toBeNull();
  expect(urls(http.requests)).toEqual(['/v1/articles/z-maintenance', '/v1/articles/a-service']);
});

it('[AC-F1-03c-NOTICE-DETAIL#14] ArticleBody 使用配置的媒体域，仅允许该域图片', async () => {
  vi.stubEnv('VITE_MEDIA_ORIGINS', CDN);
  const imageBody = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: NOTICE_BODY }] },
      { type: 'image', attrs: { src: `${CDN}/notice.png`, alt: '公告配图' } },
      {
        type: 'image',
        attrs: { src: 'https://untrusted.example.invalid/image.png', alt: '外站图片' },
      },
    ],
  });
  const http = server(() => reply({ ...noticeArticle, body: imageBody }));
  mount(http.api, detailPath);
  await screen.findByText(NOTICE_BODY);
  expect(screen.getByRole('img', { name: '公告配图' }).getAttribute('src')).toBe(
    `${CDN}/notice.png`,
  );
  expect(screen.queryByRole('img', { name: '外站图片' })).toBeNull();
});
