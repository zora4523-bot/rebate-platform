/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { AID, BASE_URL, DONE, FAILED, NOW, SUPER, createServer } from './audit-fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});
function show(menuId: string): HTMLElement {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
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
      initialRoute: { menuId },
      permissionsProvider: async () => SUPER,
      account: { username: 'ops-yi', displayName: '运营甲' },
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
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

it('[AC-F1-10j-BROWSER#1] 1440 审计列表筛选、行操作和导出入口可见，admin-audit-logs', async () => {
  await page.viewport(1440, 1100);
  const marker = show('audit-logs');
  const main = page.getByRole('main');
  await expect
    .element(main.getByRole('button', { name: '查询', exact: true }), FIRST)
    .toBeVisible();
  await expect.element(main.getByRole('button', { name: '重置', exact: true })).toBeVisible();
  await expect.element(main.getByRole('button', { name: '导出', exact: true })).toBeVisible();
  await expect
    .element(main.getByRole('link', { name: '导出记录' }))
    .toHaveAttribute('href', '/exports');
  await expect.element(main.getByLabelText(/操作人/)).toBeVisible();
  await expect.element(main.getByLabelText(/对象类型/)).toBeVisible();
  await expect.element(main.getByLabelText(/对象\s*ID/i)).toBeVisible();
  await expect.element(main.getByLabelText(/权限点/)).toBeVisible();
  await expect.element(main.getByLabelText(/开始时间|起始时间/)).toBeVisible();
  await expect.element(main.getByLabelText(/结束时间/)).toBeVisible();
  await expect.element(main.getByText('user_risk_ban', { exact: true })).toBeVisible();
  await expect.element(main.getByText(/2026-10-19 01:05/)).toBeVisible();
  await expect.element(main).toMatchTextContent(/运营甲/);
  // A link or button may navigate to the detail subpage inside main.
  await expect
    .element(
      main
        .getByRole('button', { name: `查看 ${AID}` })
        .or(main.getByRole('link', { name: `查看 ${AID}` })),
    )
    .toBeVisible();
  await screenshot('admin-audit-logs', marker);
}, 40_000);

it('[AC-F1-10j-BROWSER#2] 1440 直达审计详情，前后值与文字差异标识可见，admin-audit-log-detail', async () => {
  await page.viewport(1440, 1100);
  const marker = show(`audit-logs/${AID}`);
  const main = page.getByRole('main');
  await expect.element(main.getByText(/normal/), FIRST).toBeVisible();
  await expect.element(main.getByText(/banned/)).toBeVisible();
  await expect.element(main).toMatchTextContent(/前值|变更前/);
  await expect.element(main).toMatchTextContent(/后值|变更后/);
  await expect.element(main.getByText('state', { exact: true })).toBeVisible();
  await expect.element(main.getByText(/138\*\*\*\*5678/).first()).toBeVisible();
  await expect
    .element(
      main
        .getByText('已变更', { exact: false })
        .or(main.getByLabelText(/已变更/))
        .first(),
    )
    .toBeVisible();
  await screenshot('admin-audit-log-detail', marker);
}, 40_000);

it('[AC-F1-10j-BROWSER#3] 1440 导出任务列表、失败原因、下载和重试可见，admin-exports', async () => {
  await page.viewport(1440, 1100);
  const marker = show('exports');
  const main = page.getByRole('main');
  await expect.element(main.getByRole('columnheader', { name: '任务编号' }), FIRST).toBeVisible();
  await expect.element(main.getByRole('cell', { name: DONE, exact: true })).toBeVisible();
  await expect
    .element(
      main
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: DONE, exact: true }) })
        .getByRole('button', { name: '下载', exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      main
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: FAILED, exact: true }) })
        .getByRole('button', { name: '重试', exact: true }),
    )
    .toBeVisible();
  await expect.element(main).toMatchTextContent(/排队中/);
  await expect.element(main).toMatchTextContent(/生成中/);
  await expect.element(main).toMatchTextContent(/已完成/);
  await expect.element(main).toMatchTextContent(/已过期/);
  await expect.element(main).toMatchTextContent(/已取消/);
  await expect
    .element(main.getByText('超过导出行数上限，请缩小筛选范围', { exact: true }))
    .toBeVisible();
  await screenshot('admin-exports', marker);
}, 40_000);
