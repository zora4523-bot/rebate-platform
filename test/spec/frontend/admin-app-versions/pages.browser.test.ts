/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  LAGGING,
  PERMITTED,
  PRIMARY,
  READY,
  TARGET,
  createServer,
  failure,
  item,
  payload,
  type SaveBody,
} from './fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

function show(server = createServer()): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  // Use the default application route: this also guards production wiring.
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'app-versions' },
      permissionsProvider: async () => PERMITTED,
      account: { username: 'operator', displayName: '运营' },
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
}

async function edit(): Promise<void> {
  const current = page.getByRole('row', { name: /4\.12\.3/ });
  await expect.element(current, FIRST).toBeVisible();
  const trigger = Array.from(current.element().querySelectorAll<HTMLElement>('button, a')).find(
    (node) => /编辑/.test(node.textContent ?? node.getAttribute('aria-label') ?? ''),
  );
  expect(trigger, 'editable native row').toBeDefined();
  await page.elementLocator(trigger!).click();
  await expect.element(page.getByLabelText(/最新版本/), FIRST).toHaveValue('4.12.3');
}

it('[AC-F1-10h-BROWSER#1] 真实浏览器展示版本与只读行，编辑文案后发送完整保存请求', async () => {
  await page.viewport(1440, 1000);
  const server = createServer();
  show(server);
  const current = page.getByRole('row', { name: /4\.12\.3/ });
  await expect.element(current, FIRST).toBeVisible();
  await expect.element(current).toMatchTextContent(/2\.9\.0/);
  await expect.element(current).toMatchTextContent(/3\.4\.0/);
  await expect.element(current).toMatchTextContent(PRIMARY);
  for (const version of [/9\.0\.1/, /9\.0\.2/]) {
    const readonly = page.getByRole('row', { name: version });
    await expect.element(readonly).toBeVisible();
    expect(
      Array.from(readonly.element().querySelectorAll('button, a')).some((n) =>
        /编辑/.test(n.textContent ?? ''),
      ),
    ).toBe(false);
  }
  await edit();
  await page.getByLabelText(/更新标题|更新文案.*标题/).fill('浏览器更新标题');
  await page.getByLabelText(/更新说明|更新文案.*说明/).fill('浏览器更新说明');
  await page.getByRole('button', { name: /保存/ }).click();
  await expect.poll(() => server.requests('PUT', TARGET).length, FIRST).toBe(1);
  expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
    payload(item(), {
      update_title: '浏览器更新标题',
      update_notes: '浏览器更新说明',
    }),
  );
  expect(server.requests('POST')).toEqual([]);
}, 40_000);

it('[AC-F1-10h-BROWSER#2] 提高最低版本验证动态码，服务端核对后一次确认全部落后商店', async () => {
  await page.viewport(1440, 1000);
  const server = createServer();
  server.once('PUT', TARGET, () => failure(20001, { fields: ['confirmed_stores'] }));
  show(server);
  await edit();
  await page.getByLabelText(/最低支持版本/).fill('2.10.0');
  await page.getByRole('button', { name: /保存/ }).click();
  const step = page.getByRole('dialog', { name: /二次验证.*动态码/ });
  await expect.element(step, FIRST).toBeVisible();
  expect(server.requests('PUT')).toEqual([]);
  await step.getByLabelText('动态码', { exact: true }).fill('123456');
  await step.getByRole('button', { name: '验证并继续', exact: true }).click();
  let confirmation: HTMLElement | undefined;
  await expect
    .poll(() => {
      confirmation = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ).find(
        (node) =>
          LAGGING.every((store) => node.textContent?.includes(store)) &&
          !node.contains(page.getByLabelText(/最新版本/).element()),
      );
      return confirmation !== undefined;
    }, FIRST)
    .toBe(true);
  const modal = page.elementLocator(confirmation!);
  for (const store of LAGGING) await expect.element(modal).toMatchTextContent(store);
  await expect.element(modal).not.toMatchTextContent(READY);
  expect(confirmation!.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).toHaveLength(
    0,
  );
  expect(server.requests('PUT', TARGET)).toHaveLength(1);
  await modal.getByRole('button', { name: /确认|继续保存/ }).click();
  await expect.poll(() => server.requests('PUT', TARGET).length, FIRST).toBe(2);
  expect(server.requests('PUT', TARGET)[1]!.body).toEqual(
    payload(item(), {
      min_supported_version: '2.10.0',
      confirmed_stores: expect.any(Array),
    }),
  );
  const body = server.requests('PUT', TARGET)[1]!.body as SaveBody;
  expect(new Set(body.confirmed_stores)).toEqual(new Set(LAGGING));
}, 40_000);
