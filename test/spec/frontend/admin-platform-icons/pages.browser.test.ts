/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL } from '../admin-data/fixtures.ts';
import {
  ACTOR,
  boardState,
  createServer,
  KEYS,
  NAMES,
  publishState,
  type FakeServer,
  type Key,
  type State,
} from './fixtures.ts';

// One screenshot per board (design-hifi AdmPlatformIcon*, 1440 wide) for the orchestrator's
// side-by-side review, plus the layout facts jsdom cannot see: rendered preview sizes, the dark
// preview background, the 720 px right drawer, the highlighted row.

const FIRST = { timeout: 10_000 };
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:30:00+08:00'));
});
afterEach(() => {
  try {
    root?.unmount();
  } finally {
    root = undefined;
    vi.useRealTimers();
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  }
});

/**
 * The browser has no network: version files become inline SVG placeholders (decisions-r20 §2:
 * filled square plus the first character, corner radius per version) loaded through <img src>.
 */
function placeholder(key: Key, n: number): string {
  const radius = [4, 10, 16][(n - 1) % 3];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="${radius}" fill="#EADBC8"/>` +
    `<text x="16" y="22" font-size="16" text-anchor="middle" fill="#28251F">` +
    `${NAMES[key].slice(0, 1)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function offline(state: State): State {
  for (const key of KEYS) {
    for (const saved of state.versions.get(key)!) saved.url = placeholder(key, saved.version);
    const icon = state.icons.get(key)!;
    if (icon.current !== null)
      icon.current = { ...icon.current, url: placeholder(key, icon.current.version) };
  }
  return state;
}

function show(state: State): FakeServer {
  const server = createServer(offline(state));
  // Requests still under way, mirrored on a hidden marker so a test can wait for zero.
  let pending = 0;
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.id = 'pending-requests';
  document.body.append(marker);
  const mark = () => marker.setAttribute('data-pending', String(pending));
  mark();
  const fetch: typeof globalThis.fetch = (input, init) => {
    pending += 1;
    mark();
    return server.fetch(input, init).finally(() => {
      pending -= 1;
      mark();
    });
  };
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch,
    getToken: () => 'example-admin-token',
    onError: () => {},
  });
  const element = createAdminShell({
    router: 'memory',
    permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
    account: { username: ACTOR, displayName: '超管' },
    environment: 'test',
    onLogout: () => {},
    initialRoute: { menuId: 'platform-icons' },
    dataProvider,
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  root.render(element);
  return server;
}

async function listShown(): Promise<void> {
  await page.viewport(1440, 900);
  await expect
    .element(page.getByRole('heading', { name: '平台标识', exact: true }), FIRST)
    .toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '历史 企业微信', exact: true }), FIRST)
    .toBeVisible();
  expect(document.querySelectorAll('main .ant-table tr[data-row-key]')).toHaveLength(KEYS.length);
}

function nameOf(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return label.trim();
  const ids = element.getAttribute('aria-labelledby') ?? '';
  return ids
    .split(/\s+/)
    .map((id) => {
      const inside = Array.from(element.querySelectorAll('[id]')).find((node) => node.id === id);
      return (inside ?? document.getElementById(id))?.textContent ?? '';
    })
    .join(' ')
    .trim();
}

function previewGroup(scope: Element, name: string): HTMLElement {
  const found = Array.from(scope.querySelectorAll<HTMLElement>('[role="img"]')).filter(
    (element) => nameOf(element) === name,
  );
  expect(found, name).toHaveLength(1);
  return found[0]!;
}

/** Three <img> in the group, each visible, decoded (naturalWidth > 0), at 16, 24 and 32 px. */
async function expectImagesShown(group: Element): Promise<void> {
  const name = nameOf(group);
  const images = Array.from(group.querySelectorAll('img'));
  expect(images, name).toHaveLength(3);
  for (const image of images) await expect.element(page.elementLocator(image), FIRST).toBeVisible();
  for (const image of images) {
    const decoded = await image.decode().then(
      () => true,
      () => false,
    );
    expect(decoded && image.naturalWidth > 0, `${name}: ${image.getAttribute('src')}`).toBe(true);
  }
  expect(
    images.map((image) => Math.round(image.getBoundingClientRect().width)).sort((a, b) => a - b),
    name,
  ).toEqual([16, 24, 32]);
}

function luminance(element: Element): number {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
    if (parts.length >= 3 && (parts.length < 4 || parts[3]! > 0.5)) {
      const [r, g, b] = parts.map((value) => value / 255);
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    }
  }
  return 1;
}

function rowCell(key: Key, column: number): HTMLElement {
  const row = document.querySelector(`main .ant-table tr[data-row-key="${key}"]`);
  expect(row, key).not.toBeNull();
  return row!.children[column] as HTMLElement;
}

/**
 * A dialog that holds a text node starting with `title`. Not by accessible name: under
 * NODE_ENV=test rc-util gives every antd Drawer and Modal the id 'test-id', so a Modal over the
 * history Drawer would be named after the Drawer's title.
 */
function dialogWith(title: RegExp) {
  return page.getByRole('dialog').filter({ has: page.getByText(title) });
}

/** antd motion classes (rc-motion appear / enter / leave, zoom, fade, drawer panel slide). */
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;

/**
 * Every open antd Modal / Drawer (panel and mask) is past its enter animation. A click while a
 * dialog still zooms or slides in can be lost (#7: 「确认发布」 clicked, no request).
 */
async function still(): Promise<void> {
  const overlays = document.querySelectorAll(
    '.ant-modal, .ant-modal-mask, .ant-drawer-content-wrapper, .ant-drawer-mask',
  );
  for (const overlay of Array.from(overlays))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
}

/**
 * The final state of what is on screen: no request of the fake server under way, and nothing
 * moving. Waits use expect.element only.
 */
async function settled(): Promise<void> {
  await expect
    .element(page.elementLocator(document.getElementById('pending-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
  await still();
}

async function shoot(name: string): Promise<void> {
  await settled();
  expect(window.innerWidth).toBe(1440);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  await document.fonts.ready;
  const screenshot = await page.screenshot({ base64: true, fullPage: true });
  const fixedPath = screenshot.path.replace(/[^/]+$/, `admin-platform-icons-${name}.png`);
  await commands.writeFile(fixedPath, screenshot.base64, 'base64');
  if (fixedPath !== screenshot.path) await commands.removeFile(screenshot.path);
  const saved = await commands.readFile(fixedPath, 'base64');
  expect(saved).toBe(screenshot.base64);
  const png = Uint8Array.from(atob(saved), (character) => character.charCodeAt(0));
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  expect(view.getUint32(16)).toBe(1440);
  expect(view.getUint32(20)).toBeGreaterThanOrEqual(900);
}

async function openHistory(platform: string) {
  await page.getByRole('button', { name: `历史 ${platform}`, exact: true }).click();
  const drawer = dialogWith(new RegExp(`^版本历史 · ${platform}`));
  await expect.element(drawer, FIRST).toBeVisible();
  await still();
  return drawer;
}

it('[AC-F1-06zd-BROWSER#1] admin-platform-icons-list（AdmPlatformIcons）', async () => {
  show(boardState());
  await listShown();
  const main = document.querySelector('main')!;
  for (const header of [
    '标识',
    '当前生效',
    '预览（16 · 24 · 32px）',
    '来源登记',
    '最近变更',
    '操作',
  ])
    await expect
      .element(page.getByRole('columnheader', { name: header, exact: true }))
      .toBeVisible();
  // Rendered sizes of the three steps and a visibly darker 「深色底」.
  const light = previewGroup(main, '支付宝 版本 2，浅色底 16、24、32px');
  const dark = previewGroup(main, '支付宝 版本 2，深色底 16、24、32px');
  for (const group of [light, dark]) await expectImagesShown(group);
  // Every built-in group of the 8 rows: three visible, decoded images of the built-in file.
  const builtins = Array.from(main.querySelectorAll('[role="img"]')).filter((element) =>
    / 内置图，(?:浅|深)色底 16、24、32px$/.test(nameOf(element)),
  );
  expect(builtins).toHaveLength(KEYS.length * 2);
  for (const group of builtins) await expectImagesShown(group);
  expect(luminance(light) - luminance(dark)).toBeGreaterThan(0.4);
  const builtinDark = previewGroup(main, '淘宝 内置图，深色底 16、24、32px');
  expect(builtinDark.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(luminance(builtinDark)).toBeLessThan(0.3);
  await expect
    .element(
      page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '平台标识', exact: true }),
    )
    .toBeVisible();
  await shoot('list');
});

it('[AC-F1-06zd-BROWSER#2] admin-platform-icons-history（AdmPlatformIconHistory）', async () => {
  show(boardState());
  await listShown();
  const drawer = await openHistory('支付宝');
  await expect
    .element(drawer.getByRole('button', { name: '回滚 支付宝 到版本 1', exact: true }))
    .toBeVisible();
  await expect.element(drawer.getByText('草稿 · 来源未登记')).toBeVisible();
  // The panel slides in from the right: wait until its motion classes are gone.
  const panel = drawer.element().closest('.ant-drawer-content-wrapper');
  expect(panel, 'antd Drawer panel').not.toBeNull();
  await expect.element(page.elementLocator(panel!), FIRST).not.toHaveClass(/panel-motion/);
  expect(Math.round(drawer.element().getBoundingClientRect().right)).toBe(1440);
  expect(Math.round(drawer.element().getBoundingClientRect().width)).toBe(720);
  await shoot('history');
});

it('[AC-F1-06zd-BROWSER#3] admin-platform-icons-history-empty（AdmPlatformIconHistoryEmpty）', async () => {
  show(boardState());
  await listShown();
  const drawer = await openHistory('天猫');
  await expect.element(drawer.getByText('还没有上传过替换图')).toBeVisible();
  await expect
    .element(drawer.getByRole('button', { name: '上传替换图', exact: true }))
    .toBeVisible();
  for (const name of ['天猫 内置图，浅色底 16、24、32px', '天猫 内置图，深色底 16、24、32px'])
    await expectImagesShown(previewGroup(drawer.element(), name));
  await shoot('history-empty');
});

it('[AC-F1-06zd-BROWSER#4] admin-platform-icons-publish-confirm（AdmPlatformIconPublishConfirm）', async () => {
  show(publishState());
  await listShown();
  const drawer = await openHistory('淘宝');
  await drawer.getByRole('button', { name: '发布 淘宝 版本 1', exact: true }).click();
  const modal = dialogWith(/^发布 淘宝 版本 1/);
  await expect.element(modal, FIRST).toBeVisible();
  await expect.element(modal.getByRole('button', { name: '确认发布', exact: true })).toBeVisible();
  await expect
    .element(modal.getByRole('button', { name: '确认发布', exact: true }), FIRST)
    .toBeEnabled();
  await expect.element(modal.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await shoot('publish-confirm');
});

it('[AC-F1-06zd-BROWSER#5] admin-platform-icons-rollback-confirm（AdmPlatformIconRollbackConfirm）', async () => {
  show(boardState());
  await listShown();
  const drawer = await openHistory('支付宝');
  await drawer.getByRole('button', { name: '回滚 支付宝 到版本 1', exact: true }).click();
  const modal = dialogWith(/^回滚 支付宝 到版本 1/);
  await expect.element(modal, FIRST).toBeVisible();
  await expect.element(modal.getByRole('button', { name: '确认回滚', exact: true })).toBeVisible();
  for (const name of [
    '支付宝 版本 1（回滚后），浅色底 16、24、32px',
    '支付宝 版本 2（当前），浅色底 16、24、32px',
  ])
    expect(previewGroup(modal.element(), name).getBoundingClientRect().width).toBeGreaterThan(0);
  await shoot('rollback-confirm');
});

it('[AC-F1-06zd-BROWSER#6] admin-platform-icons-restore-confirm（AdmPlatformIconRestoreConfirm）', async () => {
  show(boardState());
  await listShown();
  await page.getByRole('button', { name: '恢复内置 支付宝', exact: true }).click();
  const modal = dialogWith(/^支付宝 恢复内置图/);
  await expect.element(modal, FIRST).toBeVisible();
  const confirm = modal.getByRole('button', { name: '确认恢复内置', exact: true });
  await expect.element(confirm).toBeVisible();
  expect(confirm.element().classList.contains('ant-btn-primary')).toBe(true);
  expect(confirm.element().classList.contains('ant-btn-dangerous')).toBe(false);
  await shoot('restore-confirm');
});

it('[AC-F1-06zd-BROWSER#7] admin-platform-icons-published（AdmPlatformIconPublished）', async () => {
  show(publishState());
  await listShown();
  const drawer = await openHistory('淘宝');
  await drawer.getByRole('button', { name: '发布 淘宝 版本 1', exact: true }).click();
  const modal = dialogWith(/^发布 淘宝 版本 1/);
  await expect.element(modal, FIRST).toBeVisible();
  await still();
  await modal.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect.element(page.getByText(/淘宝 已发布版本 1，立即生效/), FIRST).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '查看操作日志', exact: true }))
    .toBeVisible();
  await expect.element(modal).not.toBeInTheDocument();
  // The highlighted row is visibly different from its neighbours.
  const neighbour = getComputedStyle(rowCell('tmall', 1)).backgroundColor;
  await expect
    .element(page.elementLocator(rowCell('taobao', 1)), FIRST)
    .not.toHaveStyle({ backgroundColor: neighbour });
  await shoot('published');
});

it('[AC-F1-06zd-BROWSER#8] admin-platform-icons-restored（AdmPlatformIconRestored）', async () => {
  show(boardState());
  await listShown();
  await page.getByRole('button', { name: '恢复内置 支付宝', exact: true }).click();
  const modal = dialogWith(/^支付宝 恢复内置图/);
  await expect.element(modal, FIRST).toBeVisible();
  await still();
  await modal.getByRole('button', { name: '确认恢复内置', exact: true }).click();
  await expect.element(page.getByText(/支付宝 已恢复内置图。/), FIRST).toBeVisible();
  await expect.element(modal).not.toBeInTheDocument();
  await expect
    .element(page.getByRole('button', { name: '恢复内置 支付宝', exact: true }))
    .toBeDisabled();
  await shoot('restored');
});

it('[AC-F1-06zd-BROWSER#9] admin-platform-icons-conflict（AdmPlatformIconConflict）', async () => {
  const server = show(boardState());
  await listShown();
  const drawer = await openHistory('支付宝');
  await drawer.getByRole('button', { name: '回滚 支付宝 到版本 1', exact: true }).click();
  const modal = dialogWith(/^回滚 支付宝 到版本 1/);
  await expect.element(modal, FIRST).toBeVisible();
  server.change('alipay', {
    current_version: null,
    current: null,
    revision: 4,
    updated_by: 'ops-er',
    updated_at: '2026-10-12T02:31:00Z',
  });
  await still();
  await modal.getByRole('button', { name: '确认回滚', exact: true }).click();
  const alert = modal.getByRole('alert');
  await expect.element(alert, FIRST).toBeVisible();
  await expect.element(alert.getByText(/回滚未生效/)).toBeVisible();
  await expect.element(alert.getByText(/最近变更 2026-10-12 10:31 ops-er/)).toBeVisible();
  await expect
    .element(modal.getByRole('button', { name: '刷新版本历史', exact: true }))
    .toBeVisible();
  await expect
    .element(modal.getByRole('button', { name: '确认回滚', exact: true }))
    .not.toBeInTheDocument();
  // The re-read is over: the conflict notice's buttons are usable, not greyed out.
  await expect
    .element(modal.getByRole('button', { name: '刷新版本历史', exact: true }), FIRST)
    .toBeEnabled();
  await expect
    .element(modal.getByRole('button', { name: '查看操作日志', exact: true }), FIRST)
    .toBeEnabled();
  await shoot('conflict');
});
