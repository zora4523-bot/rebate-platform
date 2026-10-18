/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL, GROUPS, createServer, item } from './fixtures.ts';

const FIRST = { timeout: 10_000 };
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;
const KEY = 'withdraw.max_amount_fen';
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

/** Board sample values, not a new registry/default table or a real platform response. */
function show(): void {
  const server = createServer([
    item('withdraw.min_amount_fen', { value: 100 }),
    item(KEY, { value: 500000 }),
    item('withdraw.amount_step_fen', { value: 100, version: 1, updated_by: null }),
    item('withdraw.daily_count_per_user', { value: 1, version: 1, updated_by: null }),
    item('withdraw.monthly_count_per_user', { value: 10, version: 1, updated_by: null }),
    item('withdraw.payee_daily_count', {
      value: null,
      version: 0,
      updated_by: null,
      updated_at: null,
    }),
    item('withdraw.payout_methods', { value: ['alipay', 'bank'], value_type: 'object' }),
    item('withdraw.payout_account_verify_per_day', { value: 3, version: 1, updated_by: null }),
    item('withdraw.auto_payout.max_amount_fen', { value: 50000, version: 2 }),
  ]);
  server.history.set(KEY, [
    {
      version: 3,
      value: 500000,
      updated_by: 'ops-yi',
      reason: '当前提现上限',
      created_at: '2026-10-09T02:00:00Z',
    },
    {
      version: 2,
      value: 300000,
      updated_by: 'ops-yi',
      reason: '内测调整',
      created_at: '2026-10-08T02:00:00Z',
    },
    {
      version: 1,
      value: 500000,
      updated_by: null,
      reason: null,
      created_at: '2026-10-07T02:00:00Z',
    },
  ]);
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.id = 'config-requests';
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
      initialRoute: { menuId: 'config' },
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
}

async function screenshot(name: string): Promise<void> {
  await expect
    .element(page.elementLocator(document.getElementById('config-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
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
  await expect
    .element(page.elementLocator(document.getElementById('config-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-06zg-BROWSER#1] AdmConfigCenter：1440 宽六组导航、提现表格和种子修改人可见', async () => {
  await page.viewport(1440, 1060);
  show();
  await expect.element(page.getByText(KEY, { exact: true }), FIRST).toBeVisible();
  for (const group of GROUPS)
    await expect.element(page.getByText(group, { exact: false }).first(), FIRST).toBeVisible();
  await expect.element(page.getByRole('columnheader', { name: /当前值/ })).toBeVisible();
  await expect.element(page.getByRole('columnheader', { name: /生效范围|适用范围/ })).toBeVisible();
  await expect.element(page.getByRole('columnheader', { name: /最近修改/ })).toBeVisible();
  await expect.element(page.getByText('系统初始化', { exact: true }).first()).toBeVisible();
  await expect.element(page.getByRole('button', { name: /编辑.*单笔最高提现金额/ })).toBeVisible();
  await screenshot('admin-config-center-list');
});

it('[AC-F1-06zg-BROWSER#2] AdmConfigItemDrawer：1440 宽右侧编辑抽屉、必填原因和历史回滚可见', async () => {
  await page.viewport(1440, 1060);
  show();
  const edit = page.getByRole('button', { name: /编辑.*单笔最高提现金额/ });
  await expect.element(edit, FIRST).toBeVisible();
  await edit.click();
  const drawer = page.getByRole('dialog');
  await expect.element(drawer, FIRST).toBeVisible();
  await expect.element(drawer.getByText(KEY, { exact: true })).toBeVisible();
  await expect.element(drawer.getByText(/config\.business/)).toBeVisible();
  await expect.element(drawer.getByRole('spinbutton', { name: /新值/ })).toBeVisible();
  await expect.element(drawer.getByRole('textbox', { name: /修改原因/ })).toBeVisible();
  await expect.element(drawer.getByText('版本记录', { exact: true })).toBeVisible();
  await expect
    .element(drawer.getByRole('button', { name: /^回滚.*到\s*v2(?!\d)/ }), FIRST)
    .toBeVisible();
  await expect.element(drawer.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await expect.element(drawer.getByRole('button', { name: /保存/ })).toBeVisible();
  await screenshot('admin-config-center-drawer');
});
