/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import tokenCss from '../../../../packages/ui-tokens/src/tokens.gen.css?raw';
import { createServer as configServer, item } from '../admin-config-center/fixtures.ts';
import { BASE_URL, UID, createServer, rows } from '../admin-users/fixtures.ts';
import { color, emulateSystemDark } from './fixtures.ts';

// Capture queries before App's imports execute, including module-level subscriptions.
// Keep native EventTargets so both addListener and addEventListener receive changes.
const systemMedia = vi.hoisted(() => {
  const original = window.matchMedia;
  const queries = new Set<MediaQueryList>();
  let systemDark: boolean | null = null;
  window.matchMedia = (media) => {
    const query = original.call(window, media);
    if (/prefers-color-scheme/i.test(media)) {
      queries.add(query);
      Object.defineProperty(query, 'matches', {
        configurable: true,
        get: () =>
          systemDark === null
            ? original.call(window, media).matches
            : /prefers-color-scheme\s*:\s*light/i.test(media)
              ? !systemDark
              : systemDark,
      });
    }
    return query;
  };
  return {
    change(dark: boolean) {
      systemDark = dark;
      for (const query of [...queries])
        query.dispatchEvent(
          new MediaQueryListEvent('change', { media: query.media, matches: query.matches }),
        );
    },
    reset() {
      systemDark = null;
    },
    restore() {
      window.matchMedia = original;
      for (const query of queries) Reflect.deleteProperty(query, 'matches');
      queries.clear();
    },
  };
});

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
let oldTheme: string | null;
const sheets: HTMLStyleElement[] = [];

beforeEach(() => {
  oldTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
});
afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.restoreAllMocks();
  systemMedia.reset();
  for (const sheet of sheets.splice(0)) sheet.remove();
  document.body.replaceChildren();
  if (oldTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', oldTheme);
  window.history.replaceState(null, '', '/');
});
afterAll(() => systemMedia.restore());

function show(menuId: 'users' | 'config', fetch: typeof globalThis.fetch): HTMLElement {
  const pending = document.createElement('span');
  pending.hidden = true;
  pending.dataset['pending'] = '0';
  document.body.append(pending);
  let requests = 0;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(
    createAdminShell({
      router: 'memory',
      initialRoute: { menuId },
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'ops-yi', displayName: '超管' },
      environment: 'test',
      onLogout: () => {},
      dataProvider: createDataProvider({
        baseUrl: BASE_URL,
        fetch: async (input, init) => {
          pending.dataset['pending'] = String(++requests);
          try {
            return await fetch(input, init);
          } finally {
            pending.dataset['pending'] = String(--requests);
          }
        },
        getToken: () => 'example-admin-token',
        onError: () => {},
      }),
    }),
  );
  return pending;
}

async function screenshot(name: string, pending: HTMLElement): Promise<void> {
  await expect.element(pending, FIRST).toHaveAttribute('data-pending', '0');
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  await Promise.all(
    document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
  );
  const image = await page.screenshot({ base64: true, fullPage: true });
  const path = image.path.replace(/[^/]+$/, `${name}.png`);
  await commands.writeFile(path, image.base64, 'base64');
  if (path !== image.path) await commands.removeFile(image.path);
}

async function usersReady(): Promise<HTMLInputElement> {
  await expect.element(page.getByRole('main').getByText(UID, { exact: true }), FIRST).toBeVisible();
  const input = page.getByRole('main').getByPlaceholder('UID 或完整 11 位手机号');
  await expect.element(input).toBeVisible();
  await input.fill('13800005678');
  return input.element() as HTMLInputElement;
}

async function usersColors(mode: 'light' | 'dark'): Promise<void> {
  const key = mode === 'dark' ? 'dark' : 'value';
  await expect.element(document.documentElement).toHaveStyle({ colorScheme: mode });
  for (const selector of ['.ant-card', '.ant-table', '.ant-input-affix-wrapper']) {
    const node = document.querySelector<HTMLElement>(selector);
    await expect.element(node, FIRST).toBeVisible();
    await expect.element(node, FIRST).toHaveStyle({
      backgroundColor: color.background.surface[key],
      color: color.text.primary[key],
    });
  }
  await expect.element(document.querySelector<HTMLElement>('.admin-header'), FIRST).toHaveStyle({
    backgroundColor: color.background.surface[key],
  });
  await expect.element(document.querySelector<HTMLElement>('.admin-column'), FIRST).toHaveStyle({
    backgroundColor: color.background['admin-canvas'][key],
  });
}

it('[AC-F1-06zl-RUNTIME#1] [AC-F1-06zl-BROWSER#1] 1440 外壳与用户查询浅深截图；属性切换更新 Card/Table/Input 且保留输入', async () => {
  await page.viewport(1440, 1040);
  const pending = show('users', createServer(rows().slice(0, 8)).fetch);
  const input = await usersReady();
  await usersColors('light');
  await screenshot('admin-shell-light', pending);
  document.documentElement.setAttribute('data-theme', 'dark');
  await usersColors('dark');
  // Keep the original DOM reference: both replacing the tree and clearing state are failures.
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('13800005678');
  await screenshot('admin-shell-dark', pending);
  document.documentElement.setAttribute('data-theme', 'light');
  await usersColors('light');
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('13800005678');
});

it('[AC-F1-06zl-RUNTIME#2] 系统媒体事件在无属性变动时更新主题，强制浅色覆盖系统深色', async () => {
  document.documentElement.removeAttribute('data-theme');
  show('users', createServer(rows().slice(0, 8)).fetch);
  const input = await usersReady();
  await usersColors('light');
  const systemSheet = emulateSystemDark(tokenCss);
  sheets.push(systemSheet);
  await expect.element(systemSheet).toBeInTheDocument();
  expect(systemSheet.textContent).toContain(':root:not([data-theme="light"])');
  expect(systemSheet.textContent).toContain('--color-background-surface:');
  systemMedia.change(true);
  await usersColors('dark');
  await expect.element(document.documentElement).not.toHaveAttribute('data-theme');
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('13800005678');
  systemSheet.remove();
  systemMedia.change(false);
  await usersColors('light');
  document.documentElement.setAttribute('data-theme', 'light');
  document.head.append(systemSheet);
  systemMedia.change(true);
  await usersColors('light');
  // Removing the override must re-read the already active CSS, without another media event.
  document.documentElement.removeAttribute('data-theme');
  await usersColors('dark');
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('13800005678');
});

it('[AC-F1-06zl-RUNTIME#3] 已打开配置抽屉随主题更新派生浮层底色和正文，切回后恢复且不丢修改原因', async () => {
  const server = configServer([item('withdraw.max_amount_fen', { value: 500000 })]);
  show('config', server.fetch);
  const edit = page.getByRole('button', { name: /编辑.*单笔最高提现金额/ });
  await expect.element(edit, FIRST).toBeVisible();
  await edit.click();
  const dialog = page.getByRole('dialog');
  await expect.element(dialog, FIRST).toBeVisible();
  const reason = dialog.getByRole('textbox', { name: /修改原因/ });
  await expect.element(reason).toBeVisible();
  await reason.fill('主题切换保留草稿');
  const input = reason.element();
  const content = document.querySelector<HTMLElement>('.ant-drawer-content');
  await expect.element(content, FIRST).toBeVisible();
  const lightBackground = getComputedStyle(content!).backgroundColor;
  const lightColor = getComputedStyle(content!).color;
  document.documentElement.setAttribute('data-theme', 'dark');
  await expect.element(content, FIRST).toHaveStyle({ color: color.text.primary.dark });
  await expect.element(content, FIRST).not.toHaveStyle({ backgroundColor: lightBackground });
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('主题切换保留草稿');
  document.documentElement.setAttribute('data-theme', 'light');
  await expect.element(content, FIRST).toHaveStyle({
    backgroundColor: lightBackground,
    color: lightColor,
  });
  await expect.element(input).toBeVisible();
  await expect.element(input).toHaveValue('主题切换保留草稿');
});
