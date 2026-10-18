/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, UID, createServer } from './fixtures.ts';

const FIRST = { timeout: 10_000 };
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

function show(): HTMLElement {
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
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'users' },
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
  return marker;
}

async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  for (const overlay of Array.from(
    document.querySelectorAll('.ant-modal, .ant-modal-mask, .ant-drawer'),
  ))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-07i-BROWSER#1] 1440 用户列表：筛选、查找、脱敏列及详情入口可见', async () => {
  await page.viewport(1440, 1040);
  const marker = show();
  const main = page.getByRole('main');
  await expect.element(main.getByText(UID, { exact: true }), FIRST).toBeVisible();
  await expect.element(main.getByRole('combobox', { name: /风控状态/ })).toBeVisible();
  await expect.element(main.getByRole('textbox')).toBeVisible();
  for (const name of ['UID', '昵称', '手机号', '等级', '风控状态', '注册时间', '操作'])
    await expect.element(main.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect.element(main.getByText('138****5678', { exact: true }).first()).toBeVisible();
  await expect.element(main.getByText('2026-10-13 01:05', { exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^详情(?:\s|$)/ }).first()).toBeVisible();
  await screenshot('admin-users-list', marker);
});

it('[AC-F1-07i-BROWSER#2] 1440 用户详情：基础信息、查看按钮与只读联盟授权可见', async () => {
  await page.viewport(1440, 1160);
  const marker = show();
  const main = page.getByRole('main');
  const open = main.getByRole('button', { name: /^详情(?:\s|$)/ }).first();
  await expect.element(open, FIRST).toBeVisible();
  await open.click();
  await expect.element(main.getByText('K7QX2M', { exact: true }), FIRST).toBeVisible();
  await expect.element(main.getByText('基本信息', { exact: true })).toBeVisible();
  await expect.element(main.getByText('138****5678', { exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /^查看(?:完整手机号)?$/ })).toBeVisible();
  await expect.element(main.getByText('联盟授权', { exact: true })).toBeVisible();
  const bindings = main.getByRole('table').filter({
    has: page.getByRole('columnheader', { name: '平台', exact: true }),
  });
  await expect.element(bindings).toBeVisible();
  await expect
    .element(bindings.getByRole('columnheader', { name: '状态', exact: true }))
    .toBeVisible();
  await expect
    .element(main.getByRole('button', { name: /重置授权|停用返利/ }))
    .not.toBeInTheDocument();
  await screenshot('admin-user-detail', marker);
});
