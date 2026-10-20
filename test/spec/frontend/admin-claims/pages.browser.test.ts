/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { BASE_URL, CID, ROUTE, createServer, statusLabel } from './claims-fixtures.ts';

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
async function show(route: string) {
  const server = createServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.dataset['pending'] = '0';
  document.body.append(marker);
  let pending = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    pending += 1;
    marker.dataset['pending'] = String(pending);
    try {
      return await server.fetch(input, init);
    } finally {
      pending -= 1;
      marker.dataset['pending'] = String(pending);
    }
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
    }),
  );
  return { marker, server };
}
async function screenshot(name: string): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-07f-BROWSER#1] 1440 找回列表筛选、六状态、表格与分页可见，截图 admin-claims', async () => {
  await page.viewport(1440, 1080);
  const { marker } = await show('/claims');
  const main = page.getByRole('main');
  // All baseline waits originate here, before actions; missing routes fail by assertion.
  await expect.element(main.getByRole('table'), FIRST).toBeVisible();
  await expect.element(main.getByRole('heading', { name: '找回审核' })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /平台/ })).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /证据等级/ })).toBeVisible();
  await expect.element(main.getByRole('textbox', { name: /订单号.*找回单号/ })).toBeVisible();
  await expect.element(main.getByRole('textbox', { name: /^用户/ })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^查询$/ })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^重置$/ })).toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('submitted')) }))
    .toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('auto_matched')) }))
    .toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('manual_review')) }))
    .toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('approved')) }))
    .toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('rejected')) }))
    .toBeVisible();
  await expect
    .element(main.getByRole('tab', { name: new RegExp(statusLabel('cancelled')) }))
    .toBeVisible();
  await expect.element(main.getByRole('table')).toMatchTextContent(CID);
  await expect.element(main).not.toMatchTextContent('一键通过');
  await expect.element(main).not.toMatchTextContent('今日新提交');
  await expect.element(document.querySelector<HTMLElement>('.ant-pagination')).toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  marker.dataset['overflow'] = String(document.documentElement.scrollWidth > window.innerWidth);
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-overflow', 'false');
  await screenshot('admin-claims');
});

it('[AC-F1-07f-BROWSER#2] 1440 审核页证据比对、两子订单和说明操作可见，截图 admin-claim-review', async () => {
  await page.viewport(1440, 1360);
  const { marker, server } = await show(ROUTE);
  const main = page.getByRole('main');
  await expect.element(main.getByRole('button', { name: /^通过$/ }).first(), FIRST).toBeVisible();
  await expect.element(main).toMatchTextContent(CID);
  await expect.element(main).toMatchTextContent('用户填写');
  await expect.element(main).toMatchTextContent('联盟回传');
  await expect.element(main).toMatchTextContent(server.claim.items[0]!.sub_order_id);
  await expect.element(main).toMatchTextContent(server.claim.items[1]!.sub_order_id);
  await expect.element(main.getByRole('textbox', { name: /说明/ }).first()).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^通过$/ }).last()).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^驳回$/ }).first()).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^驳回$/ }).last()).toBeVisible();
  await expect.element(main.getByRole('button', { name: /返回/ })).toBeVisible();
  await expect.element(main).toMatchTextContent('锁定');
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  marker.dataset['overflow'] = String(document.documentElement.scrollWidth > window.innerWidth);
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-overflow', 'false');
  await screenshot('admin-claim-review');
});
