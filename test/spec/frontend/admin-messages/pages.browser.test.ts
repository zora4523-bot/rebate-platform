/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, FULL, PHONE, TEMPLATE, channelPath, createServer, smsPath } from './fixtures.ts';

// The real /messages route of the admin app in Chromium: the 消息模板 tab with its switches, a
// switch through the real step-up dialog, then the 短信 tab and a template change in the drawer.
// Waits use expect.element only.
const FIRST = { timeout: 10_000 };
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

async function show(server = createServer()) {
  auth = harness().create();
  await signIn(auth);
  window.history.replaceState(null, '', '/messages');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'browser',
      authProvider: auth,
      permissionsProvider: async () => FULL,
      account: { username: 'ops-yi', displayName: '运营' },
      environment: 'test',
      onLogout: () => {},
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

function tabPanel() {
  return page.getByRole('main').getByRole('tabpanel');
}
async function verifyStepUp(): Promise<void> {
  const verification = page.getByRole('dialog', { name: '二次验证 · 动态码' });
  await expect.element(verification, FIRST).toBeVisible();
  await verification.getByLabelText('动态码', { exact: true }).fill('123456');
  await verification.getByRole('button', { name: '验证并继续' }).click();
}

it('[AC-F1-06zv-BROWSER#1] /messages 消息模板页签：按编码列出开关，真实动态码后关推送，PATCH 只带推送与 row_version', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const tab = page.getByRole('main').getByRole('tab', { name: '消息模板' });
  await expect.element(tab, FIRST).toBeVisible();
  await tab.click();
  await expect.element(tabPanel(), FIRST).toMatchTextContent('WD_FAILED');
  await expect.element(tabPanel()).toMatchTextContent('恒开');
  const push = tabPanel().getByRole('switch', { name: /^推送\s*WD_SUCCESS(?![A-Z0-9_])/ });
  await expect.element(push, FIRST).toBeVisible();
  await expect.element(push).toHaveAttribute('aria-checked', 'true');
  await push.click();
  expect(server.requests('PATCH')).toEqual([]);
  await verifyStepUp();
  await expect.element(push, FIRST).toHaveAttribute('aria-checked', 'false');
  const sent = server.requests('PATCH', channelPath('WD_SUCCESS'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.body).toEqual({ push: false, row_version: 4 });
  expect(sent[0]!.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
});

it('[AC-F1-06zv-BROWSER#2] /messages 短信页签：列出登记与「未登记」，抽屉换模板 CODE 后真实动态码，受理并写明测试发送号码', async () => {
  await page.viewport(1440, 1080);
  const server = await show();
  const tab = page.getByRole('main').getByRole('tab', { name: '短信' });
  await expect.element(tab, FIRST).toBeVisible();
  await tab.click();
  await expect.element(tabPanel(), FIRST).toMatchTextContent(TEMPLATE.smsCode);
  await expect.element(tabPanel()).toMatchTextContent('未登记');
  const row = tabPanel().getByRole('row').filter({ hasText: 'SMS_CODE' });
  const edit = row.getByRole('button', { name: /^编\s*辑/ });
  await expect.element(edit, FIRST).toBeVisible();
  await edit.click();
  const template = page.getByLabelText(/模板\s*CODE|模板编号|模板代码/i);
  await expect.element(template, FIRST).toBeVisible();
  await template.fill(TEMPLATE.replacement);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(?:验证并|确认|提交|保存|测试发送)/ })
    .click();
  await verifyStepUp();
  await expect.element(page.getByText(PHONE).first(), FIRST).toBeVisible();
  await expect.element(tabPanel(), FIRST).toMatchTextContent(TEMPLATE.replacement);
  const sent = server.requests('PUT', smsPath('SMS_CODE'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.query).toEqual({ variant: 'default' });
  expect(sent[0]!.body).toMatchObject({ template_code: TEMPLATE.replacement, row_version: 2 });
});
