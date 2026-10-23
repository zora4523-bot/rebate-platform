// @vitest-environment jsdom
// F1-06zu (D10-284): without the option nothing is blocked (the frozen page tests mount the shell
// that way); once a route ships its operationId leaves the generated list and the page works again.
import { createElement } from 'react';
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ENDPOINT as DASHBOARD,
  createServer as dashboardServer,
} from '../admin-dashboard/dashboard-fixtures.ts';
import {
  DETAIL as ORDER_DETAIL,
  LIST as ORDERS,
  NUMBER,
  ROUTE as ORDER_ROUTE,
  createServer as ordersServer,
} from '../admin-orders/orders-fixtures.ts';
import { LIST as RISK_RULES, createServer as riskServer } from '../admin-risk-rules/fixtures.ts';
import {
  ORDER_NUMBER,
  SEARCH,
  createServer as searchServer,
} from '../admin-search/search-fixtures.ts';
import {
  LIST as UNION_ACCOUNTS,
  createServer as unionsServer,
  ok as unionsOk,
} from '../admin-unions/fixtures.ts';
import {
  ALL_PLANNED,
  FLOW_TIMEOUT,
  OPS,
  PLANNED,
  attemptSearch,
  mainElement,
  mount,
  placeholder,
  planned,
  quiet,
  recorder,
  reset,
  routes,
  searchBox,
  searchMarked,
  settled,
  shipped,
} from './kit.ts';

/** One fake backend for every page of this file (each test gets fresh state). */
function backend(): typeof globalThis.fetch {
  return routes([
    [/^\/admin\/v1\/dashboard$/, dashboardServer().fetch],
    [/^\/admin\/v1\/orders/, ordersServer().fetch],
    [/^\/admin\/v1\/union-pids$/, async () => unionsOk({ items: [] })],
    [/^\/admin\/v1\/union-accounts/, unionsServer().fetch],
    [/^\/admin\/v1\/risk-rules/, riskServer().fetch],
    [/^\/admin\/v1\/search$/, searchServer().fetch],
  ]);
}

it(
  '[AC-F1-06zu-DEFAULT#1] 不传 plannedOperations 时 /orders 照常请求 GET /admin/v1/orders 并显示列表；传入含 adminListOrders 的清单才显示占位',
  async () => {
    const first = recorder(ordersServer().fetch);
    await mount({ route: '/orders', fetch: first.fetch });
    await waitFor(() => expect(mainElement().textContent).toContain(NUMBER));
    expect(first.hits('GET', ORDERS).length).toBeGreaterThan(0);
    expect(mainElement().textContent).not.toContain(PLANNED);
    reset();
    const second = recorder(ordersServer().fetch);
    const { onError } = await mount({
      route: '/orders',
      fetch: second.fetch,
      planned: planned(OPS.listOrders),
    });
    await placeholder();
    await settled(second);
    expect(second.log).toEqual([]);
    quiet(onError);
  },
  FLOW_TIMEOUT,
);

const CASES = [
  { name: '工作台', route: '/dashboard', ops: [OPS.dashboard], path: DASHBOARD },
  { name: '订单查询', route: '/orders', ops: [OPS.listOrders], path: ORDERS },
  { name: '订单详情', route: ORDER_ROUTE, ops: [OPS.getOrder], path: ORDER_DETAIL },
  {
    name: '联盟账号页签',
    route: '/unions',
    ops: [OPS.unionAccounts, OPS.alertPhones],
    path: UNION_ACCOUNTS,
  },
  { name: '风控规则清单', route: '/risk', ops: [OPS.riskRules], path: RISK_RULES },
] as const;

it.each(CASES)(
  '[AC-F1-06zu-RECOVER#1] $name：依赖仍在清单里时占位不请求；清单去掉其依赖（接口已上线重新生成）后自动恢复并照常请求',
  async ({ route, ops, path }) => {
    const first = recorder(backend());
    await mount({ route, fetch: first.fetch, planned: ALL_PLANNED });
    await placeholder();
    await settled(first);
    expect(first.hits('GET', path)).toEqual([]);
    reset();
    const second = recorder(backend());
    await mount({ route, fetch: second.fetch, planned: shipped(...ops) });
    await waitFor(() => expect(second.hits('GET', path).length).toBeGreaterThan(0));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zu-RECOVER#2] 顶栏一框搜：adminSearch 在清单里时不请求；清单去掉 adminSearch 后回车照常请求 GET /admin/v1/search',
  async () => {
    const page = () => createElement('p', null, 'page:static');
    const first = recorder(backend());
    await mount({ route: '/users', fetch: first.fetch, planned: ALL_PLANNED, renderPage: page });
    await waitFor(() => expect(mainElement().textContent).toContain('page:static'));
    const blocked = await searchBox();
    await attemptSearch(blocked, ORDER_NUMBER);
    await settled(first);
    expect(first.hits('GET', SEARCH)).toEqual([]);
    await waitFor(() => expect(searchMarked(blocked)).toBe(true));
    reset();
    const second = recorder(backend());
    await mount({
      route: '/users',
      fetch: second.fetch,
      planned: shipped(OPS.search),
      renderPage: page,
    });
    await waitFor(() => expect(mainElement().textContent).toContain('page:static'));
    const box = await searchBox();
    expect(box.disabled).toBe(false);
    await attemptSearch(box, ORDER_NUMBER);
    await waitFor(() => expect(second.hits('GET', SEARCH).length).toBeGreaterThan(0));
  },
  FLOW_TIMEOUT,
);
