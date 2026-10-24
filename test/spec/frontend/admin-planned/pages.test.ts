// @vitest-environment jsdom
// F1-06zu (D10-284): a page or tab whose read depends on a planned operation keeps its menu, shows
// the 「功能开发中」 placeholder, sends none of its requests and shows no error.
import { createElement } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ENDPOINT as DASHBOARD,
  createServer as dashboardServer,
} from '../admin-dashboard/dashboard-fixtures.ts';
import {
  DETAIL as ORDER_DETAIL,
  NUMBER,
  ROUTE as ORDER_ROUTE,
  createServer as ordersServer,
} from '../admin-orders/orders-fixtures.ts';
import { createServer as riskServer } from '../admin-risk-rules/fixtures.ts';
import {
  ORDER_NUMBER,
  SEARCH,
  createServer as searchServer,
} from '../admin-search/search-fixtures.ts';
import { createServer as unionsServer, ok as unionsOk } from '../admin-unions/fixtures.ts';
import {
  FLOW_TIMEOUT,
  OPS,
  attemptSearch,
  click,
  mainElement,
  menuLink,
  mount,
  placeholder,
  planned,
  quiet,
  recorder,
  routes,
  searchBox,
  searchMarked,
  settled,
  tab,
} from './kit.ts';

it(
  '[AC-F1-06zu-PAGE#1] 工作台依赖 adminGetDashboard 为 planned：菜单照常并选中，内容区「功能开发中」，不请求、不报错',
  async () => {
    const server = recorder(dashboardServer().fetch);
    const { directFetch, onError } = await mount({
      route: '/dashboard',
      fetch: server.fetch,
      planned: planned(OPS.dashboard),
    });
    await placeholder();
    await settled(server);
    expect(menuLink('工作台').getAttribute('aria-current')).toBe('page');
    expect(server.hits('GET', DASHBOARD)).toEqual([]);
    expect(server.log).toEqual([]);
    expect(mainElement().textContent).not.toContain('昨日概览');
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-PAGE#2] 从侧栏点订单查询（adminListOrders 为 planned）照常进入 /orders，显示占位、不请求订单列表',
  async () => {
    const server = recorder(
      routes([
        [/^\/admin\/v1\/dashboard$/, dashboardServer().fetch],
        [/^\/admin\/v1\/orders/, ordersServer().fetch],
      ]),
    );
    const { directFetch, onError } = await mount({
      route: '/dashboard',
      fetch: server.fetch,
      planned: planned(OPS.dashboard, OPS.listOrders, OPS.getOrder),
    });
    await placeholder();
    await click(menuLink('订单查询'));
    await waitFor(() => expect(window.location.pathname).toBe('/orders'));
    await waitFor(() => expect(menuLink('订单查询').getAttribute('aria-current')).toBe('page'));
    await placeholder();
    await settled(server);
    expect(server.log).toEqual([]);
    expect(mainElement().textContent).not.toContain(NUMBER);
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-PAGE#3] 订单详情直达地址依赖 adminGetOrder 为 planned：订单查询菜单照常，显示占位、不请求该单',
  async () => {
    const server = recorder(ordersServer().fetch);
    const { directFetch, onError } = await mount({
      route: ORDER_ROUTE,
      fetch: server.fetch,
      planned: planned(OPS.getOrder),
    });
    await placeholder();
    await settled(server);
    expect(window.location.pathname).toBe(ORDER_ROUTE);
    expect(menuLink('订单查询').getAttribute('aria-current')).toBe('page');
    expect(server.hits('GET', ORDER_DETAIL)).toEqual([]);
    expect(server.log).toEqual([]);
    expect(mainElement().textContent).not.toContain('分佣快照');
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it.each([['adminListUnionAccounts'], ['adminListUnionAlertPhones']])(
  '[AC-F1-06zu-PAGE#4] 联盟账号页签依赖的 %s 为 planned：页签照常、显示占位、不请求联盟账号与告警手机号；推广位页签照常请求 union-pids',
  async (operationId) => {
    const unions = unionsServer();
    const server = recorder(
      routes([
        [/^\/admin\/v1\/union-pids$/, async () => unionsOk({ items: [] })],
        // The 推广位 tab reads its account choices here (F1-10gc, CT-24s).
        [/^\/admin\/v1\/union\/account-options$/, async () => unionsOk({ items: [] })],
        [/^\/admin\/v1\/union-accounts/, unions.fetch],
      ]),
    );
    const { directFetch, onError } = await mount({
      route: '/unions',
      fetch: server.fetch,
      planned: planned(operationId),
    });
    await placeholder();
    await settled(server);
    expect(menuLink('联盟账号与推广位').getAttribute('aria-current')).toBe('page');
    expect(tab('联盟账号').getAttribute('aria-selected')).toBe('true');
    expect(server.hits('GET', /^\/admin\/v1\/union-accounts/)).toEqual([]);
    expect(server.log).toEqual([]);
    expect(mainElement().textContent).not.toContain('测试 OAuth 账号');
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
    await click(tab('推广位'));
    await waitFor(() =>
      expect(server.hits('GET', '/admin/v1/union-pids').length).toBeGreaterThan(0),
    );
    // F1-10gc: the 推广位 tab takes its accounts from account-options, still not union-accounts.
    await waitFor(() =>
      expect(server.hits('GET', '/admin/v1/union/account-options').length).toBeGreaterThan(0),
    );
    await settled(server);
    expect(server.hits('GET', /^\/admin\/v1\/union-accounts/)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-PAGE#5] 风控规则清单页签依赖 adminListRiskRules 为 planned：菜单与页签照常，显示占位、不请求',
  async () => {
    const server = recorder(riskServer().fetch);
    const { directFetch, onError } = await mount({
      route: '/risk',
      fetch: server.fetch,
      planned: planned(OPS.riskRules),
    });
    await placeholder();
    await settled(server);
    expect(menuLink('风控').getAttribute('aria-current')).toBe('page');
    expect(tab('规则清单')).toBeDefined();
    expect(server.log).toEqual([]);
    expect(screen.queryAllByRole('table')).toHaveLength(0);
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-PAGE#6] 顶栏一框搜依赖 adminSearch 为 planned：输入框仍在顶栏，置灰或点开即「功能开发中」，回车与放大镜都不请求',
  async () => {
    const server = recorder(searchServer().fetch);
    const { directFetch, onError } = await mount({
      route: '/users',
      fetch: server.fetch,
      planned: planned(OPS.search),
      renderPage: () => createElement('p', null, 'page:static'),
    });
    await waitFor(() => expect(mainElement().textContent).toContain('page:static'));
    const box = await searchBox();
    await attemptSearch(box, ORDER_NUMBER);
    await settled(server);
    expect(server.hits('GET', SEARCH)).toEqual([]);
    await waitFor(() => expect(searchMarked(box)).toBe(true));
    await settled(server);
    expect(server.log).toEqual([]);
    expect(document.body.textContent).not.toContain('搜索失败');
    expect(document.body.textContent).not.toContain('请输入 1–64 个字的号码');
    quiet(onError);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);
