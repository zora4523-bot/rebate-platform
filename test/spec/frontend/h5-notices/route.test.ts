// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import { NoticePage } from '../../../../apps/h5/src/entries/app/pages/notices/index.ts';
import { AgreementPage } from '../../../../apps/h5/src/entries/app/pages/agreements/index.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { entry, mount } from './helpers.ts';
import { NOTICE_BODY, notices, server } from './fixtures.ts';

it('[AC-F1-03c-ROUTE#1] 公告和协议各自懒加载本任务页面，既有规则页仍可用', async () => {
  const routes = createAppRoutes();
  for (const [path, component] of [
    [bridge.routes.Notice.h5_path, NoticePage],
    [bridge.routes.Agreement.h5_path, AgreementPage],
    [bridge.routes.Rules.h5_path, RulesPage],
  ] as const) {
    const route = routes.find((item) => item.path === path);
    expect(route).toBeDefined();
    expect((await route!.lazy()).Component).toBe(component);
  }
  // Do not freeze the route inventory: Help is being connected in F1-03b.
  expect(routes.every((route) => typeof route.lazy === 'function')).toBe(true);
});

it('[AC-F1-03c-ROUTE#2] 查询串 article_id 直接打开详情，不先加载列表', async () => {
  const http = server(
    () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: '',
          data: {
            article_id: 'x',
            category: 'notice',
            title: '指定公告',
            version: 1,
            published_at: '2026-09-30T17:30:00Z',
            body: JSON.stringify({
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: NOTICE_BODY }] }],
            }),
          },
          trace_id: 'route-fixture',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  mount(http.api, '/notice?article_id=x');
  await screen.findByRole('heading', { name: '指定公告', level: 1 });
  expect(await screen.findByText(NOTICE_BODY)).toBeTruthy();
  expect(http.requests.map((request) => new URL(request.url).pathname)).toEqual(['/v1/articles/x']);
});

it('[AC-F1-03c-ROUTE#3] 点公告卡片切查询串详情，浏览器后退恢复列表', async () => {
  const http = server();
  const view = mount(http.api);
  await screen.findByText(notices[0]!.notice.text);
  await userEvent.setup().click(entry(/订单同步维护通知/));
  await screen.findByText(NOTICE_BODY);
  expect(screen.getByTestId('location').textContent).toBe('/notice?article_id=z-maintenance');
  expect(screen.getByRole('heading', { level: 1, name: notices[0]!.title })).toBeTruthy();
  await view.go(-1);
  await screen.findByText(notices[0]!.notice.text);
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/notice'));
  expect(screen.queryByText(NOTICE_BODY)).toBeNull();
  expect(entry(/国庆期间客服时间调整/)).toBeTruthy();
});
