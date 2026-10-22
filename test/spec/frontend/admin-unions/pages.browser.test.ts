/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import {
  BASE_URL,
  CALLBACK,
  CREDENTIAL,
  GRANT,
  NOW,
  SECRET,
  STATE,
  createServer,
} from './fixtures.ts';

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
async function show(route = '/unions', server = createServer()) {
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
      permissionsProvider: async () => ({ isSuper: false, permissions: ['union.account_auth'] }),
      account: { username: 'ops-yi', displayName: '运营' },
      environment: 'test',
      onLogout: () => {},
      clock: { now: () => NOW },
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: server.fetch,
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return server;
}

it('[AC-F1-10ga-BROWSER#1] /unions 真实路由显示双页签、账号字段与分模式入口', async () => {
  await page.viewport(1440, 1080);
  const server = createServer();
  for (const row of server.state) row.alert_phones_configured = false;
  server.phones.items = [];
  await show('/unions', server);
  const main = page.getByRole('main');
  await expect
    .element(main.getByRole('tab', { name: '联盟账号' }), { timeout: 10_000 })
    .toBeVisible();
  await expect.element(main.getByRole('tab', { name: '推广位' })).toBeVisible();
  await expect.element(main).toMatchTextContent('测试 OAuth 账号');
  await expect.element(main).toMatchTextContent('测试手工账号');
  await expect.element(main).toMatchTextContent('测试免授权账号');
  await expect.element(main).toMatchTextContent('估算');
  await expect.element(main).toMatchTextContent('未配置告警手机号');
  await expect.element(main.getByRole('button', { name: '重新授权', exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: '录入新凭据', exact: true })).toBeVisible();
});

it('[AC-F1-10ga-BROWSER#2] 真实浏览器手工录入经过动态码并更新列表，凭据不回显', async () => {
  const server = await show();
  const entry = page.getByRole('main').getByRole('button', { name: '录入新凭据', exact: true });
  await expect.element(entry, { timeout: 10_000 }).toBeVisible();
  await entry.click();
  const form = page.getByRole('dialog', { name: /录入新凭据/ });
  const input = form.getByLabelText(/^(?:新)?凭据$/);
  await expect.element(input).toHaveAttribute('type', 'password');
  await input.fill(SECRET);
  await form.getByRole('button', { name: /^(?:验证并.*|确认.*|提交.*|保存.*)$/ }).click();
  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification).toBeVisible();
  expect(server.requests('PUT', CREDENTIAL)).toEqual([]);
  await verification.getByLabelText('动态码', { exact: true }).fill('123456');
  await verification.getByRole('button', { name: '验证并继续' }).click();
  await expect.element(page.getByRole('main')).toMatchTextContent(/2027[-/]0?4[-/]0?4/);
  await expect.element(document.body).not.toMatchTextContent(SECRET);
  expect(server.requests('PUT', CREDENTIAL)).toHaveLength(1);
  expect(server.requests('PUT', CREDENTIAL)[0]!.body).toEqual({ credential: SECRET });
});

it('[AC-F1-10ga-BROWSER#3] 独立回调路由解析地址栏参数，成功且只发送一次，侧栏不新增回调入口', async () => {
  const server = await show(
    `/unions/oauth-callback?${new URLSearchParams({ state: STATE, code: GRANT })}`,
  );
  const main = page.getByRole('main');
  await expect.element(main, { timeout: 10_000 }).toMatchTextContent(/成功|已完成|已授权/);
  await expect.element(document.body).not.toMatchTextContent(GRANT);
  expect(server.requests('POST', CALLBACK).map((r) => r.body)).toEqual([
    { state: STATE, code: GRANT },
  ]);
  expect(document.querySelector('aside a[href="/unions/oauth-callback"]')).toBeNull();
});
