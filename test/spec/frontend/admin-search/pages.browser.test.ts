/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import {
  BASE_URL,
  EMPTY,
  FOOTER,
  NO_HIT_FOOTER,
  PLACEHOLDER,
  UNKNOWN_NUMBER,
  USER,
  WITHDRAWAL,
  WITHDRAWAL_NUMBER,
  createServer,
  type Result,
} from './search-fixtures.ts';

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

function show(result: Result): HTMLElement {
  const server = createServer(result);
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

async function search(query: string): Promise<void> {
  const region = page.getByRole('banner').getByRole('search');
  const input = region.getByRole('textbox');
  // Assert before any locator action so the baseline fails by assertion, never a click timeout.
  await expect.element(region, FIRST).toBeVisible();
  await expect.element(input).toHaveAttribute('placeholder', PLACEHOLDER);
  await input.fill(query);
  await userEvent.keyboard('{Enter}');
}

async function screenshot(name: string, marker: HTMLElement): Promise<void> {
  await expect
    .element(page.getByRole('main').getByRole('heading', { name: /昨日概览/ }), FIRST)
    .toBeVisible();
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  for (const overlay of Array.from(document.querySelectorAll('.ant-dropdown')))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
  await expect.element(page.elementLocator(marker), FIRST).toHaveAttribute('data-pending', '0');
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

async function width(marker: HTMLElement, expected: number): Promise<void> {
  const region = page.getByRole('banner').getByRole('search');
  await expect.element(region, FIRST).toBeVisible();
  // Measure the complete antd Search control (input plus magnifier), not the input alone.
  const control = region.element().querySelector<HTMLElement>('.ant-input-search');
  await expect.element(control).toBeVisible();
  marker.dataset['searchWidth'] = String(Math.round(control!.getBoundingClientRect().width));
  await expect
    .element(page.elementLocator(marker))
    .toHaveAttribute('data-search-width', String(expected));
}

it('[AC-F1-07h-BROWSER#1] 1440 多命中下拉与首条高亮、摘要、固定说明可见，admin-search-multi', async () => {
  await page.viewport(1440, 1360);
  const marker = show({ items: [WITHDRAWAL, USER], truncated: false });
  await search(WITHDRAWAL_NUMBER);
  const list = page.getByRole('listbox');
  await expect.element(list, FIRST).toBeVisible();
  const first = list.getByRole('option').first();
  await expect.element(first).toHaveAttribute('aria-selected', 'true');
  await expect.element(first).toMatchTextContent('提现单');
  await expect.element(first).toMatchTextContent(WITHDRAWAL.summary);
  await expect.element(list.getByRole('option').last()).toMatchTextContent(USER.summary);
  await expect.element(list.getByText(FOOTER, { exact: false })).toBeVisible();
  await width(marker, 280);
  await screenshot('admin-search-multi', marker);
});

it('[AC-F1-07h-BROWSER#2] 1440 无命中提示和完整号码说明可见且不提权限，admin-search-no-hit', async () => {
  await page.viewport(1440, 1360);
  const marker = show(EMPTY);
  await search(UNKNOWN_NUMBER);
  const message = page.getByText(`没有找到「${UNKNOWN_NUMBER}」`, { exact: false });
  const footer = page.getByText(NO_HIT_FOOTER, { exact: false });
  await expect.element(message, FIRST).toBeVisible();
  await expect.element(footer).toBeVisible();
  // Status, alert and plain containers are all valid for an empty result.
  let panel = message.element();
  const footerElement = footer.element();
  while (!panel.contains(footerElement) && panel.parentElement) panel = panel.parentElement;
  await expect.element(page.elementLocator(panel)).not.toMatchTextContent('权限');
  await expect.element(page.getByRole('option')).not.toBeInTheDocument();
  await screenshot('admin-search-no-hit', marker);
});

it('[AC-F1-07h-BROWSER#3] 1280 搜索框收为 220 宽，候选可见且 Esc 返回输入焦点', async () => {
  await page.viewport(1280, 1360);
  const marker = show({ items: [WITHDRAWAL, USER], truncated: false });
  await search(WITHDRAWAL_NUMBER);
  const list = page.getByRole('listbox');
  await expect.element(list, FIRST).toBeVisible();
  await width(marker, 220);
  const rect = list.element().getBoundingClientRect();
  marker.dataset['withinViewport'] = String(rect.left >= 0 && rect.right <= window.innerWidth);
  marker.dataset['focusInList'] = String(list.element().contains(document.activeElement));
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-within-viewport', 'true');
  await expect.element(page.elementLocator(marker)).toHaveAttribute('data-focus-in-list', 'true');
  await userEvent.keyboard('{ArrowDown}');
  await expect.element(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{Escape}');
  await expect.element(list).not.toBeInTheDocument();
  await expect.element(page.getByRole('search').getByRole('textbox')).toHaveFocus();
});
