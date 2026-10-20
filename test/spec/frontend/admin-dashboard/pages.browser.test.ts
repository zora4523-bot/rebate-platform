/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  CARDS,
  FINANCE,
  SUPER,
  createServer,
  financeDashboard,
} from './dashboard-fixtures.ts';

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

function show(finance = false): HTMLElement {
  const server = finance ? createServer(financeDashboard()) : createServer();
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
      initialRoute: { menuId: 'dashboard' },
      permissionsProvider: async () => (finance ? FINANCE : SUPER),
      account: {
        username: finance ? 'finance.xiaoli' : 'ops-yi',
        displayName: finance ? '财务小狸' : '超管',
      },
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
async function ready(marker: HTMLElement): Promise<void> {
  await expect
    .element(page.getByRole('main').getByRole('heading', { name: /昨日概览/ }), FIRST)
    .toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
}
async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await ready(marker);
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}
async function layout(marker: HTMLElement, columns: number | undefined): Promise<void> {
  const links = CARDS.map(([, title]) =>
    page.getByRole('main').getByRole('link', { name: new RegExp(`^${title} `) }),
  );
  for (const link of links) await expect.element(link, FIRST).toBeVisible();
  const rects = links.map((link) => link.element().getBoundingClientRect());
  marker.dataset['overflow'] = String(document.documentElement.scrollWidth > window.innerWidth);
  marker.dataset['equalHeight'] = String(
    Math.max(...rects.map((r) => r.height)) - Math.min(...rects.map((r) => r.height)) <= 1,
  );
  const firstRow = rects.filter((r) => Math.abs(r.top - rects[0]!.top) <= 1);
  marker.dataset['columns'] = String(firstRow.length);
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-overflow', 'false');
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-equal-height', 'true');
  if (columns !== undefined)
    await expect
      .element(page.elementLocator(marker))
      .toHaveAttribute('data-columns', String(columns));
}

it('[AC-F1-14a-BROWSER#1] 1440 超管八张待办、四列等高、昨日概览及状态，admin-dashboard', async () => {
  await page.viewport(1440, 1360);
  const marker = show();
  await ready(marker);
  const main = page.getByRole('main');
  await expect
    .element(page.getByRole('navigation', { name: '主导航' }).getByRole('link').first())
    .toHaveTextContent('工作台');
  await expect.element(main.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
  await expect.element(main.getByRole('heading', { name: /系统状态/ })).toBeVisible();
  await expect.element(main.getByText(/1,236\.40/)).toBeVisible();
  await expect.element(main.getByText(/未接入|未录入|暂无数据|未知/)).toBeVisible();
  await expect.element(main.getByText(/未关闭告警|open_alerts/)).not.toBeInTheDocument();
  await layout(marker, 4);
  await screenshot('admin-dashboard', marker);
});

it('[AC-F1-14a-BROWSER#2] 1440 财务只显示服务端返回三张待办，admin-dashboard-finance', async () => {
  await page.viewport(1440, 1200);
  const marker = show(true);
  await ready(marker);
  const main = page.getByRole('main');
  for (const [key, title] of CARDS) {
    const link = main.getByRole('link', { name: new RegExp(`^${title} `) });
    if (['withdraw_review_pending', 'settle_bill_pending', 'recon_diff_open'].includes(key))
      await expect.element(link).toBeVisible();
    else await expect.element(link).not.toBeInTheDocument();
  }
  await expect.element(main.getByRole('heading', { name: /系统状态/ })).toBeVisible();
  await screenshot('admin-dashboard-finance', marker);
});

it('[AC-F1-14a-BROWSER#3] 1280 窄窗八张卡与筛选链接可见且不横向溢出，admin-dashboard-1280', async () => {
  await page.viewport(1280, 1760);
  const marker = show();
  await ready(marker);
  await layout(marker, undefined);
  for (const [, title, , route] of CARDS)
    await expect
      .element(page.getByRole('main').getByRole('link', { name: new RegExp(`^${title} `) }))
      .toHaveAttribute('href', route);
  await screenshot('admin-dashboard-1280', marker);
});

it('[AC-F1-14a-BROWSER#4] 1100 及以下待办改两列等高、不横向溢出', async () => {
  await page.viewport(1100, 1400);
  const marker = show();
  await ready(marker);
  await layout(marker, 2);
  await page.viewport(1024, 1400);
  await ready(marker);
  await layout(marker, 2);
});
