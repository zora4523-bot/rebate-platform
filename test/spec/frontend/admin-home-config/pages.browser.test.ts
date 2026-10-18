/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, createServer } from './fixtures.ts';

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

function show(): void {
  const server = createServer();
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.id = 'home-config-requests';
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
  // Default production route is an independent acceptance check of App.tsx wiring.
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId: 'pages' },
      permissionsProvider: async () => ({ isSuper: false, permissions: ['content.page'] }),
      account: { username: 'ops-editor', displayName: '运营' },
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
}
async function screenshot(name: string): Promise<void> {
  const pending = page.elementLocator(document.getElementById('home-config-requests')!);
  await expect.element(pending, FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  for (const overlay of Array.from(
    document.querySelectorAll(
      '.ant-drawer, .ant-drawer-mask, .ant-drawer-content-wrapper, .ant-modal, .ant-modal-mask',
    ),
  ))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  await expect.element(pending, FIRST).toHaveAttribute('data-pending', '0');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-09l-BROWSER#1] 1440 编辑器：页面选择、JSON、只读区块、保存、发布与草稿预览可见', async () => {
  await page.viewport(1440, 1060);
  show();
  const main = page.getByRole('main');
  await expect.element(main.getByRole('textbox', { name: /JSON/i }), FIRST).toBeVisible();
  await expect.element(main.getByRole('textbox', { name: /JSON/i })).not.toHaveValue('');
  await expect.element(main.getByRole('combobox', { name: /页面/ })).toBeVisible();
  for (const name of ['hero', 'member-grid', '全部用户'])
    await expect.element(main.getByText(name, { exact: false }).first()).toBeVisible();
  for (const name of [/保存草稿/, /^发布$/, /版本历史/, /草稿预览/])
    await expect.element(main.getByRole('button', { name })).toBeVisible();
  await screenshot('admin-home-config-editor');
});

it('[AC-F1-09l-BROWSER#2] 1440 版本历史：线上与灰度卡、表格、版本行操作和返回编辑器可见', async () => {
  await page.viewport(1440, 1060);
  show();
  const main = page.getByRole('main');
  const history = main.getByRole('button', { name: /版本历史/ });
  await expect.element(history, FIRST).toBeVisible();
  await history.click();
  for (const name of [
    /版本/,
    /状态/,
    /灰度比例|比例/,
    /渲染次数/,
    /错误次数/,
    /发布人/,
    /发布时间/,
  ])
    await expect.element(main.getByRole('columnheader', { name }), FIRST).toBeVisible();
  for (const name of [/调整比例/, /转为全量/, /停止灰度/, /返回编辑器/])
    await expect.element(main.getByRole('button', { name })).toBeVisible();
  await expect.element(main.getByRole('button', { name: /查看/ }).first()).toBeVisible();
  await expect.element(main.getByText(/15%/).first()).toBeVisible();
  await screenshot('admin-home-config-versions');
});
