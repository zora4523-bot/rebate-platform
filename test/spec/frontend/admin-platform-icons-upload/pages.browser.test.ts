/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL } from '../admin-data/fixtures.ts';
import { NAMES } from '../admin-platform-icons/fixtures.ts';
import { COPY } from './copy.ts';
import {
  ACTOR,
  boardState,
  createUploadServer,
  isUpload,
  KEYS,
  registerState,
  svgFile,
  SVG_UNCONVERTIBLE,
  reject,
  type Gate,
  type Key,
  type State,
  type UploadServer,
} from './fixtures.ts';

// One screenshot per board (design-hifi AdmPlatformIconUpload, …Uploading, …UploadCleaned,
// …UploadInvalid, …Saved, …SourceRegister; 1440 wide) for the orchestrator's side-by-side
// review, plus what jsdom cannot see: the cleaned preview's images really decode at 16 / 24 / 32
// px. Waits use expect.element only.

const FIRST = { timeout: 10_000 };
let root: Root | undefined;
const gates: Gate[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:30:00+08:00'));
});
afterEach(() => {
  try {
    for (const gate of gates.splice(0)) gate.release();
    root?.unmount();
  } finally {
    root = undefined;
    vi.useRealTimers();
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  }
});

/**
 * The browser has no network: version and upload files become inline SVG placeholders
 * (decisions-r20 §2: filled square plus the first character) loaded through <img src>.
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

function show(state: State, prepare: (server: UploadServer) => void = () => {}): UploadServer {
  const server = createUploadServer(offline(state));
  prepare(server);
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
    .element(page.getByRole('button', { name: '上传 淘宝', exact: true }), FIRST)
    .toBeVisible();
}

/**
 * A dialog that holds a text node starting with `title`. Not by accessible name: under
 * NODE_ENV=test rc-util gives every antd Drawer and Modal the id 'test-id'.
 */
function dialogWith(title: RegExp) {
  return page.getByRole('dialog').filter({ has: page.getByText(title) });
}

/** antd motion classes (rc-motion appear / enter / leave, zoom, fade, drawer panel slide). */
const MOTION =
  /(?:^|\s)ant-(?:zoom|fade|move|slide)\b|-(?:appear|enter|leave)(?:-|\s|$)|-motion\b|-motion-/;

/** Every open antd Modal / Drawer (panel and mask) is past its enter animation. */
async function still(): Promise<void> {
  const overlays = document.querySelectorAll(
    '.ant-modal, .ant-modal-mask, .ant-drawer-content-wrapper, .ant-drawer-mask, .ant-picker-dropdown',
  );
  for (const overlay of Array.from(overlays))
    await expect.element(page.elementLocator(overlay), FIRST).not.toHaveClass(MOTION);
}

/** No request of the fake server under way, and nothing moving. */
async function settled(): Promise<void> {
  await expect
    .element(page.elementLocator(document.getElementById('pending-requests')!), FIRST)
    .toHaveAttribute('data-pending', '0');
  await still();
}

async function shoot(name: string, wait: () => Promise<void> = settled): Promise<void> {
  await wait();
  expect(window.innerWidth).toBe(1440);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1440);
  await document.fonts.ready;
  const screenshot = await page.screenshot({ base64: true, fullPage: true });
  const fixedPath = screenshot.path.replace(/[^/]+$/, `admin-platform-icons-upload-${name}.png`);
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

async function openUpload(platform: string) {
  await page.getByRole('button', { name: `上传 ${platform}`, exact: true }).click();
  const modal = dialogWith(new RegExp(`^上传替换图 · ${platform}`));
  await expect.element(modal, FIRST).toBeVisible();
  return modal;
}

/** Puts `file` into the dialog's file input the way the file chooser does. */
async function choose(modal: ReturnType<typeof dialogWith>, file: File): Promise<void> {
  const inputs = modal.element().querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs).toHaveLength(1);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  inputs[0]!.files = transfer.files;
  inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
  await expect
    .element(modal.getByRole('button', { name: COPY.upload, exact: true }), FIRST)
    .toBeEnabled();
}

function previewGroup(scope: Element, name: string): HTMLElement {
  const found = Array.from(scope.querySelectorAll<HTMLElement>('[role="img"]')).filter(
    (element) => {
      const label = element.getAttribute('aria-label');
      if (label !== null) return label.trim() === name;
      const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/);
      const text = ids
        .map((id) => {
          const inside = Array.from(element.querySelectorAll('[id]')).find(
            (node) => node.id === id,
          );
          return (inside ?? document.getElementById(id))?.textContent ?? '';
        })
        .join(' ')
        .trim();
      return text === name;
    },
  );
  expect(found, name).toHaveLength(1);
  return found[0]!;
}

/** Three <img> in the group, each visible, decoded (naturalWidth > 0), at 16, 24 and 32 px. */
async function expectImagesShown(group: Element): Promise<void> {
  // Rendered sizes are only meaningful once the dialog's zoom-in animation is over.
  await still();
  const images = Array.from(group.querySelectorAll('img'));
  expect(images).toHaveLength(3);
  for (const image of images) await expect.element(page.elementLocator(image), FIRST).toBeVisible();
  for (const image of images) {
    const decoded = await image.decode().then(
      () => true,
      () => false,
    );
    expect(decoded && image.naturalWidth > 0, image.getAttribute('src') ?? '').toBe(true);
  }
  expect(
    images.map((image) => Math.round(image.getBoundingClientRect().width)).sort((a, b) => a - b),
  ).toEqual([16, 24, 32]);
}

/**
 * Relative luminance of the first opaque computed background at or above `element` (same check
 * as the frozen F1-06zd browser tests): what is actually painted behind a preview group.
 */
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

/** 「{平台} {行名}，浅色底 …」 sits on a light and 「…深色底 …」 on a visibly dark background. */
function expectLightAndDark(scope: Element, platform: string, row: string): void {
  const light = previewGroup(scope, `${platform} ${row}，浅色底 16、24、32px`);
  const dark = previewGroup(scope, `${platform} ${row}，深色底 16、24、32px`);
  expect(light.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(dark.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(luminance(light), `${platform} ${row} 浅色底`).toBeGreaterThan(0.7);
  expect(luminance(dark), `${platform} ${row} 深色底`).toBeLessThan(0.3);
  expect(luminance(light) - luminance(dark)).toBeGreaterThan(0.4);
}

/** Opens the date panel of the field labelled `label` and clicks day `value` (cell title). */
async function pickDate(scope: ReturnType<typeof dialogWith>, label: RegExp, value: string) {
  await scope.getByLabelText(label).click();
  const day = page.getByTitle(value, { exact: true });
  await expect.element(day, FIRST).toBeVisible();
  await still();
  await day.click();
  await expect.element(scope.getByLabelText(label), FIRST).toHaveValue(value);
}

it('[AC-F1-06ze-BROWSER#1] admin-platform-icons-upload-upload（AdmPlatformIconUpload）', async () => {
  show(boardState());
  await listShown();
  const modal = await openUpload('淘宝');
  await expect.element(modal.getByText(COPY.noFile, { exact: false })).toBeVisible();
  await expect.element(modal.getByText(COPY.rule1, { exact: false })).toBeVisible();
  await expect
    .element(modal.getByRole('button', { name: COPY.upload, exact: true }))
    .toBeDisabled();
  await shoot('upload');
});

it('[AC-F1-06ze-BROWSER#2] admin-platform-icons-upload-uploading（AdmPlatformIconUploading）', async () => {
  const server = show(boardState(), (target) => target.uploadAs({ url: placeholder('taobao', 1) }));
  gates.push(server.hold(isUpload));
  await listShown();
  const modal = await openUpload('淘宝');
  await choose(modal, svgFile('taobao-logo.svg', 9216));
  await modal.getByRole('button', { name: COPY.upload, exact: true }).click();
  await expect.element(modal.getByText(COPY.uploading, { exact: false }), FIRST).toBeVisible();
  await expect.element(modal.getByText(COPY.discard, { exact: false })).toBeVisible();
  await expect
    .element(modal.getByRole('button', { name: '取消', exact: true }), FIRST)
    .toBeEnabled();
  // The upload is still under way on purpose: wait only for the dialog to stop moving.
  await shoot('uploading', still);
});

it('[AC-F1-06ze-BROWSER#3] admin-platform-icons-upload-cleaned（AdmPlatformIconUploadCleaned）', async () => {
  show(boardState(), (server) =>
    server.uploadAs({ url: placeholder('taobao', 1), sanitized: true }),
  );
  await listShown();
  const modal = await openUpload('淘宝');
  await choose(modal, svgFile('taobao-logo.svg', 9216));
  await modal.getByRole('button', { name: COPY.upload, exact: true }).click();
  await expect.element(modal.getByText(COPY.sanitizedBody, { exact: false }), FIRST).toBeVisible();
  for (const name of [
    '淘宝 清洗后，浅色底 16、24、32px',
    '淘宝 清洗后，深色底 16、24、32px',
    '淘宝 内置图，浅色底 16、24、32px',
    '淘宝 内置图，深色底 16、24、32px',
  ])
    await expectImagesShown(previewGroup(modal.element(), name));
  // BR-TEXT-24 「预览：浅色与深色底上的 16、24、32px 三档」: the backgrounds really differ.
  for (const row of ['清洗后', '内置图']) expectLightAndDark(modal.element(), '淘宝', row);
  await modal.getByRole('checkbox', { name: COPY.confirm }).click();
  await modal.getByLabelText(COPY.sourceLabel).fill('https://brand.example.com/taobao');
  await pickDate(modal, COPY.dateLabel, '2026-10-12');
  await expect
    .element(modal.getByRole('button', { name: COPY.save, exact: true }), FIRST)
    .toBeEnabled();
  await shoot('cleaned');
});

it('[AC-F1-06ze-BROWSER#4] admin-platform-icons-upload-invalid（AdmPlatformIconUploadInvalid）', async () => {
  show(boardState(), (server) => server.once(isUpload, reject(SVG_UNCONVERTIBLE, 400)));
  await listShown();
  const modal = await openUpload('淘宝');
  await choose(modal, svgFile('taobao-brand.svg', 26624));
  await modal.getByRole('button', { name: COPY.upload, exact: true }).click();
  await expect.element(modal.getByText(COPY.unconvertible, { exact: false }), FIRST).toBeVisible();
  await expect.element(modal.getByText(COPY.notUploaded, { exact: false })).toBeVisible();
  await shoot('invalid');
});

it('[AC-F1-06ze-BROWSER#5] admin-platform-icons-upload-saved（AdmPlatformIconSaved）', async () => {
  show(boardState(), (server) =>
    server.uploadAs({ url: placeholder('taobao', 1), sanitized: true }),
  );
  await listShown();
  const modal = await openUpload('淘宝');
  await choose(modal, svgFile('taobao-logo.svg', 9216));
  await modal.getByRole('button', { name: COPY.upload, exact: true }).click();
  await expect.element(modal.getByText(COPY.sanitizedBody, { exact: false }), FIRST).toBeVisible();
  await modal.getByRole('checkbox', { name: COPY.confirm }).click();
  await modal.getByLabelText(COPY.sourceLabel).fill('https://brand.example.com/taobao');
  await pickDate(modal, COPY.dateLabel, '2026-10-12');
  await modal.getByRole('button', { name: COPY.save, exact: true }).click();
  const drawer = dialogWith(/^版本历史 · 淘宝/);
  await expect.element(drawer, FIRST).toBeVisible();
  await expect
    .element(drawer.getByText(COPY.savedPublishable(1), { exact: false }), FIRST)
    .toBeVisible();
  await expect
    .element(drawer.getByRole('button', { name: '发布 淘宝 版本 1', exact: true }), FIRST)
    .toBeEnabled();
  await expect.element(modal).not.toBeInTheDocument();
  const panel = drawer.element().closest('.ant-drawer-content-wrapper');
  expect(panel, 'antd Drawer panel').not.toBeNull();
  await expect.element(page.elementLocator(panel!), FIRST).not.toHaveClass(/panel-motion/);
  for (const name of ['淘宝 版本 1，浅色底 16、24、32px', '淘宝 版本 1，深色底 16、24、32px'])
    await expectImagesShown(previewGroup(drawer.element(), name));
  for (const row of ['版本 1', '内置图']) expectLightAndDark(drawer.element(), '淘宝', row);
  await shoot('saved');
});

it('[AC-F1-06ze-BROWSER#6] admin-platform-icons-upload-source-register（AdmPlatformIconSourceRegister）', async () => {
  show(registerState());
  await listShown();
  await page.getByRole('button', { name: '历史 支付宝', exact: true }).click();
  const drawer = dialogWith(/^版本历史 · 支付宝/);
  await expect.element(drawer, FIRST).toBeVisible();
  await drawer.getByRole('button', { name: '补登来源 支付宝 版本 3', exact: true }).click();
  const modal = dialogWith(/^补登来源 · 支付宝 版本 3/);
  await expect.element(modal, FIRST).toBeVisible();
  await modal.getByLabelText(COPY.sourceLabel).fill('https://brand.example.com/alipay');
  await pickDate(modal, COPY.dateLabel, '2026-10-09');
  await expect
    .element(modal.getByRole('button', { name: COPY.saveRegister, exact: true }), FIRST)
    .toBeEnabled();
  await shoot('source-register');
});
