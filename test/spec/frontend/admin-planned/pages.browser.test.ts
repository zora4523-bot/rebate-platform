/// <reference types="@vitest/browser-playwright" />
// F1-06zu (D10-284) in a real Chromium: planned pages keep their menu, show 「功能开发中」 and send
// nothing; the 推广位 tab next to a planned 联盟账号 tab still reads its list.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, NUMBER, createServer as ordersServer } from '../admin-orders/orders-fixtures.ts';
import { createServer as unionsServer, ok as unionsOk } from '../admin-unions/fixtures.ts';

const FIRST = { timeout: 10_000 };
const TEST_TIMEOUT = 60_000;
let root: Root | undefined;
let auth: AdminAuthProvider | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  auth?.dispose();
  auth = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** Mounts the shell at `route`; every request path is appended to the returned list. */
async function show(
  route: string,
  backend: typeof globalThis.fetch,
  plannedOperations: ReadonlySet<string>,
): Promise<string[]> {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
    return backend(input, init);
  };
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', route);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
      plannedOperations,
    }),
  );
  return requests;
}

it(
  '[AC-F1-06zu-BROWSER#1] 1440 订单查询依赖 planned：侧栏菜单可见可点，内容区「功能开发中」，不发订单请求',
  async () => {
    await page.viewport(1440, 900);
    const requests = await show(
      '/orders',
      ordersServer().fetch,
      new Set(['adminListOrders', 'adminGetOrder']),
    );
    const main = page.getByRole('main');
    await expect.element(main, FIRST).toMatchTextContent('功能开发中');
    const link = page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '订单查询' });
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute('aria-current', 'page');
    await link.click();
    await expect.element(main).toMatchTextContent('功能开发中');
    await expect.element(main).not.toMatchTextContent(NUMBER);
    expect(requests).toEqual([]);
  },
  TEST_TIMEOUT,
);

it(
  '[AC-F1-06zu-BROWSER#2] 1440 联盟账号页签依赖 planned 时显示占位且不请求，切到推广位照常请求 union-pids',
  async () => {
    await page.viewport(1440, 900);
    const unions = unionsServer();
    const backend: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      return path === '/admin/v1/union-pids' ? unionsOk({ items: [] }) : unions.fetch(input, init);
    };
    const requests = await show(
      '/unions',
      backend,
      new Set(['adminListUnionAccounts', 'adminListUnionAlertPhones']),
    );
    const main = page.getByRole('main');
    await expect.element(main, FIRST).toMatchTextContent('功能开发中');
    await expect.element(main.getByRole('tab', { name: '联盟账号' })).toBeVisible();
    await expect.element(main).not.toMatchTextContent('测试 OAuth 账号');
    expect(requests).toEqual([]);
    await main.getByRole('tab', { name: '推广位' }).click();
    await expect.poll(() => requests, FIRST).toContain('/admin/v1/union-pids');
  },
  TEST_TIMEOUT,
);
