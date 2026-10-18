// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CDN } from '../h5-rules/fixtures.ts';
import {
  appApi,
  articles,
  BODY_HEADING,
  BODY_TEXT,
  doc,
  fakeBridge,
  helpServer,
  paragraph,
  reply,
} from './fixtures.ts';
import { entry, mount, paths } from './helpers.ts';

it('[AC-F1-03b-ARTICLE#1] 详情匿名请求一次，显示 h1、帮助标签、北京跨日日期及结构化正文', async () => {
  const http = helpServer();
  const native = fakeBridge();
  const view = mount(appApi(http, native), {
    url: '/help?article_id=z-faq-47',
    bridge: native.bridge,
  });
  await screen.findByText(BODY_TEXT);
  expect(screen.getByRole('heading', { name: articles[0]!.title, level: 1 })).toBeTruthy();
  expect(screen.getByText('帮助', { exact: true })).toBeTruthy();
  expect(view.container.textContent).toMatch(/更新于\s*2026-10-05/);
  expect(view.container.textContent).not.toMatch(/更新于\s*2026-10-04/);
  expect(screen.getByRole('heading', { name: BODY_HEADING, level: 2 })).toBeTruthy();
  expect(screen.getByText(BODY_TEXT).tagName).toBe('P');
  expect(view.container.querySelectorAll('ol > li')).toHaveLength(2);
  expect(entry('还有问题，联系客服')).toBeTruthy();
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47']);
  expect(http.requests[0]!.method).toBe('GET');
  expect(new URL(http.requests[0]!.url).search).toBe('');
  expect(http.requests[0]!.headers.has('Authorization')).toBe(false);
  expect(http.requests[0]!.headers.has('X-Device-Id')).toBe(false);
  expect(native.getToken).not.toHaveBeenCalled();
  expect(native.authenticatedRequest).not.toHaveBeenCalled();
});

it('[AC-F1-03b-ARTICLE#2] 详情未返回时显示加载态，返回后移除', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = helpServer(() => pending.promise);
  const view = mount(http.api, { url: '/help?article_id=z-faq-47' });
  await waitFor(() => expect(http.requests).toHaveLength(1));
  expect(
    view.container.querySelector(
      '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]',
    ),
  ).not.toBeNull();
  expect(screen.queryByText(BODY_TEXT)).toBeNull();
  await act(async () => {
    pending.resolve(reply(articles[0]));
  });
  await screen.findByText(BODY_TEXT);
  expect(
    view.container.querySelector('[aria-busy="true"], [data-slot="skeleton-block"]'),
  ).toBeNull();
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47']);
});

it('[AC-F1-03b-ARTICLE#3] 30701 显示不存在或下线空态，返回帮助首页可继续浏览', async () => {
  const http = helpServer();
  mount(http.api, { url: '/help?article_id=unpublished-123' });
  await screen.findByText('文章不存在或已下线');
  expect(paths(http.requests)).toEqual(['/v1/articles/unpublished-123']);
  expect(screen.queryByRole('button', { name: /重试|重新加载/ })).toBeNull();
  await userEvent.setup().click(entry(/返回帮助首页|返回帮助中心/));
  await screen.findByRole('heading', { name: '常见问题' });
  expect(screen.getByTestId('location').textContent).toBe('/help');
  expect(entry(articles[0]!.title)).toBeTruthy();
  expect(paths(http.requests)).toEqual(['/v1/articles/unpublished-123', '/v1/articles']);
});

it('[AC-F1-03b-ARTICLE#4] 其他错误显示出错态，重试只重发指定详情一次', async () => {
  const http = helpServer((_url, count) =>
    count === 1 ? reply(null, 50001, 500) : reply(articles[0]),
  );
  mount(http.api, { url: '/help?article_id=z-faq-47' });
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(screen.queryByText('文章不存在或已下线')).toBeNull();
  expect(http.requests).toHaveLength(1);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试|重新加载/ }));
  await screen.findByText(BODY_TEXT);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47', '/v1/articles/z-faq-47']);
});

it('[AC-F1-03b-ARTICLE#5] 正文 JSON 无法解析时显示出错态，不白屏', async () => {
  const http = helpServer(() => reply({ ...articles[0], body: '{broken JSON' }));
  mount(http.api, { url: '/help?article_id=z-faq-47' });
  expect((await screen.findByRole('alert')).textContent).toMatch(/失败|出错|无法/);
  expect(screen.queryByText(BODY_TEXT)).toBeNull();
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47']);
});

it('[AC-F1-03b-ARTICLE#6] 复用正文组件的媒体白名单，允许 shared/env 配置域，拒绝其他域', async () => {
  vi.stubEnv('VITE_MEDIA_ORIGINS', CDN);
  const http = helpServer(() =>
    reply({
      ...articles[0],
      body: doc(
        paragraph(BODY_TEXT),
        { type: 'image', attrs: { src: `${CDN}/help.png`, alt: '允许的帮助示意图' } },
        {
          type: 'image',
          attrs: { src: 'https://untrusted.invalid/track.png', alt: '不允许的图片' },
        },
      ),
    }),
  );
  const view = mount(http.api, { url: '/help?article_id=z-faq-47' });
  await screen.findByText(BODY_TEXT);
  expect(screen.getByRole('img', { name: '允许的帮助示意图' }).getAttribute('src')).toBe(
    `${CDN}/help.png`,
  );
  expect(screen.queryByRole('img', { name: '不允许的图片' })).toBeNull();
  expect(view.container.querySelectorAll('img')).toHaveLength(1);
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47']);
});
