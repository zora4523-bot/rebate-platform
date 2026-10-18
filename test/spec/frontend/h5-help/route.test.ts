// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { HelpPage } from '../../../../apps/h5/src/entries/app/pages/help/index.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import { articles, BODY_TEXT, helpServer } from './fixtures.ts';
import { entry, mount, paths } from './helpers.ts';

it('[AC-F1-03b-ROUTE#1] Help 懒加载本页，Rules 仍加载规则页且保留全部契约 H5 路由', async () => {
  const routes = createAppRoutes();
  const help = routes.find((route) => route.path === bridge.routes.Help.h5_path);
  expect(help).toBeDefined();
  expect((await help!.lazy()).Component).toBe(HelpPage);
  const rules = routes.find((route) => route.path === bridge.routes.Rules.h5_path);
  expect(rules).toBeDefined();
  expect((await rules!.lazy()).Component).toBe(RulesPage);
  expect(routes.map((route) => route.path).sort()).toEqual(
    Object.values(bridge.routes)
      .filter((route) => route.kind === 'h5' && route.h5_path !== null)
      .map((route) => route.h5_path)
      .sort(),
  );
});

it('[AC-F1-03b-ROUTE#2] 带 article_id 的直接入口只请求指定详情，不先请求列表', async () => {
  const http = helpServer();
  mount(http.api, { url: '/help?article_id=z-faq-47' });
  await screen.findByText(BODY_TEXT);
  expect(screen.getByRole('heading', { name: articles[0]!.title, level: 1 })).toBeTruthy();
  expect(paths(http.requests)).toEqual(['/v1/articles/z-faq-47']);
});

it('[AC-F1-03b-ROUTE#3] 首页点击条目推入查询串历史，后退回帮助首页，不整页跳转', async () => {
  const http = helpServer();
  const browserUrl = window.location.href;
  mount(http.api);
  await screen.findByText(articles[0]!.title);
  await userEvent.setup().click(entry(articles[0]!.title));
  await screen.findByText(BODY_TEXT);
  expect(screen.getByTestId('location').textContent).toBe('/help?article_id=z-faq-47');
  expect(window.location.href).toBe(browserUrl);
  expect(paths(http.requests)).toEqual(['/v1/articles', '/v1/articles/z-faq-47']);
  await userEvent.setup().click(screen.getByRole('button', { name: 'fixture-back' }));
  await screen.findByRole('heading', { name: '常见问题' });
  expect(screen.getByTestId('location').textContent).toBe('/help');
  expect(entry(articles[1]!.title)).toBeTruthy();
  expect(screen.queryByText(BODY_TEXT)).toBeNull();
});
