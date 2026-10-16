import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { BASE_URL } from '../admin-data/fixtures.ts';
import {
  ACTOR,
  BUILTIN_FILES,
  createServer,
  KEYS,
  NAMES,
  type FakeServer,
  type Key,
  type State,
} from './fixtures.ts';

// The first antd Table / Drawer / Modal render of a file (cold CSS-in-JS in jsdom) takes seconds
// on a loaded runner (F1-06zc): a wider window for this directory's waits only.
configure({ asyncUtilTimeout: 10_000 });

/** Per-test timeout for the multi-step flows (each step renders antd overlays in jsdom). */
export const FLOW_TIMEOUT = 40_000;

export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['content.platform_icon'],
};

/**
 * Mounts the real admin app (createAdminShell, the production entry) on the platform marks menu
 * with the REST data provider over the fake server. `globalThis.fetch` is replaced by a spy that
 * always fails: the page must load images only as <img>, never read their bytes.
 */
export function mount(
  state: State | FakeServer = createServer(),
  overrides: Partial<AdminAppOptions> = {},
) {
  const server = 'fetch' in state ? state : createServer(state);
  const media = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new TypeError('media bytes must not be fetched')),
  );
  vi.stubGlobal('fetch', media);
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => 'example-admin-token',
    onError: vi.fn(),
  });
  const view = render(
    createAdminShell({
      router: 'memory',
      permissionsProvider: async () => PERMITTED,
      account: { username: ACTOR, displayName: '超管' },
      environment: 'test',
      onLogout: vi.fn(),
      initialRoute: { menuId: 'platform-icons' },
      dataProvider,
      ...overrides,
    }),
  );
  return { ...view, server, media };
}

export function mainElement(): HTMLElement {
  const main = document.querySelector<HTMLElement>('main');
  expect(main, 'the shell renders its main landmark').not.toBeNull();
  return main!;
}

/** Waits for the antd table with one row per mark (rowKey = key) and returns its root. */
export async function listTable(): Promise<HTMLElement> {
  await waitFor(() => {
    const root = mainElement().querySelector('.ant-table');
    expect(root, 'antd Table in the main area').not.toBeNull();
    expect(root!.querySelectorAll('tr[data-row-key]')).toHaveLength(KEYS.length);
  });
  return mainElement().querySelector<HTMLElement>('.ant-table')!;
}

export function rowKeys(table: HTMLElement): string[] {
  return Array.from(table.querySelectorAll('tr[data-row-key]'), (row) =>
    row.getAttribute('data-row-key'),
  ).filter((key): key is string => key !== null);
}

export function row(key: Key): HTMLElement {
  const found = mainElement().querySelector<HTMLElement>(`.ant-table tr[data-row-key="${key}"]`);
  expect(found, `table row ${key}`).not.toBeNull();
  return found!;
}

export function headers(table: HTMLElement): string[] {
  const header = table.querySelector('thead tr');
  expect(header, 'table header row').not.toBeNull();
  return Array.from(header!.children, (cell) => clean(cell.textContent));
}

/** The body cell of `key` under the column titled `title`. */
export function cell(key: Key, title: string): HTMLElement {
  const table = mainElement().querySelector<HTMLElement>('.ant-table')!;
  const index = headers(table).indexOf(title);
  expect(index, `column ${title}`).toBeGreaterThanOrEqual(0);
  const found = row(key).children[index];
  expect(found, `${key} / ${title}`).toBeDefined();
  return found as HTMLElement;
}

export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Text with all whitespace removed (layouts split lines differently; the words must match). */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

export function expectText(element: Element, ...parts: string[]): void {
  const text = squash(element.textContent);
  for (const part of parts) expect(text, `text of ${element.tagName}`).toContain(squash(part));
}

/**
 * Accessible name from aria-label or aria-labelledby (what the boards use). The label element is
 * looked up inside the element first: under NODE_ENV=test rc-util's useId gives every antd Drawer
 * and Modal the same id ('test-id'), so a document-wide lookup would name a Modal opened over the
 * history Drawer after the Drawer's title.
 */
export function nameOf(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return clean(label);
  const ids = element.getAttribute('aria-labelledby');
  if (ids === null) return '';
  return clean(
    ids
      .split(/\s+/)
      .map((id) => {
        const inside = Array.from(element.querySelectorAll('[id]')).find((node) => node.id === id);
        return (inside ?? element.ownerDocument.getElementById(id))?.textContent ?? '';
      })
      .join(' '),
  );
}

const PREVIEW_NAME = /，(?:浅|深)色底 16、24、32px$/;

/** Names of the preview groups (role="img", 「{平台} {行名}，浅色底 16、24、32px」) in scope. */
export function previewNames(scope: Element): string[] {
  return Array.from(scope.querySelectorAll('[role="img"]'), nameOf).filter((name) =>
    PREVIEW_NAME.test(name),
  );
}

export function preview(scope: Element, name: string): HTMLElement {
  const found = Array.from(scope.querySelectorAll<HTMLElement>('[role="img"]')).filter(
    (element) => nameOf(element) === name,
  );
  expect(found, `preview 「${name}」`).toHaveLength(1);
  return found[0]!;
}

function imageSize(image: HTMLImageElement): number {
  const values = [
    image.getAttribute('width'),
    image.style.width,
    image.getAttribute('height'),
    image.style.height,
  ];
  for (const value of values) {
    const size = Number.parseFloat(value ?? '');
    if (Number.isFinite(size) && size > 0) return size;
  }
  return Number.NaN;
}

/** A replacement preview: three <img> of the cleaned url at 16, 24 and 32 px, nothing inlined. */
export function expectReplacementPreview(scope: Element, name: string, url: string): void {
  const group = preview(scope, name);
  const images = Array.from(group.querySelectorAll('img'));
  expect(
    images.map((image) => image.getAttribute('src')),
    name,
  ).toEqual([url, url, url]);
  expect(images.map(imageSize).sort((a, b) => a - b)).toEqual([16, 24, 32]);
  expect(group.querySelectorAll('svg, object, iframe, embed, use, foreignObject')).toHaveLength(0);
}

/** The platform key of a preview name 「{平台} {行名}，…」. */
export function keyOfPreview(name: string): Key {
  const platform = name.slice(0, name.indexOf(' '));
  const key = KEYS.find((candidate) => NAMES[candidate] === platform);
  expect(key, `platform of preview 「${name}」`).toBeDefined();
  return key!;
}

/** The admin's built-in file of `key` as an <img src> (Vite asset URL, query allowed). */
export function builtinSrc(key: Key): RegExp {
  return new RegExp(`/platform-icons/assets/${BUILTIN_FILES[key]}\\.svg(?:\\?.*)?$`);
}

/**
 * A built-in preview group: three <img> at 16, 24 and 32 px, each the built-in file of that
 * group's platform (BR-TEXT-24 key → file table), never a replacement file, nothing inlined.
 */
export function expectBuiltinPreview(
  scope: Element,
  name: string,
  urls: readonly string[] = [],
): void {
  const group = preview(scope, name);
  const images = Array.from(group.querySelectorAll('img'));
  expect(images, `${name}: three built-in images`).toHaveLength(3);
  const pattern = builtinSrc(keyOfPreview(name));
  for (const image of images) {
    const src = image.getAttribute('src') ?? '';
    expect(src, name).toMatch(pattern);
    expect(urls, name).not.toContain(src);
  }
  expect(images.map(imageSize).sort((a, b) => a - b)).toEqual([16, 24, 32]);
  expect(group.querySelectorAll('svg, object, iframe, embed, use, foreignObject')).toHaveLength(0);
}

/** Every built-in preview group in scope (name contains 「内置图」) is a correct built-in group. */
export function expectAllBuiltinPreviews(scope: Element, minimum: number): void {
  const names = previewNames(scope).filter((name) => name.includes(' 内置图'));
  expect(names.length, 'built-in preview groups').toBeGreaterThanOrEqual(minimum);
  for (const name of names) expectBuiltinPreview(scope, name);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    // A closed antd Drawer may stay mounted (rc-drawer drops ant-drawer-open, hides by class).
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}

/** Open dialogs (antd Drawer / Modal) whose name starts with `title`. */
export function dialogs(title: string): HTMLElement[] {
  const start = new RegExp(`^${escape(title)}`);
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
    (dialog) => visible(dialog) && nameOf(dialog) !== '' && start.test(nameOf(dialog)),
  );
}

export async function dialog(title: string): Promise<HTMLElement> {
  await waitFor(() => expect(dialogs(title), `dialog 「${title}」`).toHaveLength(1));
  return dialogs(title)[0]!;
}

export async function dialogClosed(title: string): Promise<void> {
  await waitFor(() => expect(dialogs(title), `dialog 「${title}」 closed`).toHaveLength(0));
}

export function button(scope: HTMLElement, name: string | RegExp): HTMLButtonElement {
  const found = within(scope).queryAllByRole('button', { name });
  expect(found, `button 「${String(name)}」`).toHaveLength(1);
  return found[0] as HTMLButtonElement;
}

export function noButton(scope: HTMLElement, name: string | RegExp): void {
  expect(within(scope).queryAllByRole('button', { name }), `no button 「${String(name)}」`).toEqual(
    [],
  );
}

export async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** Opens 【历史】 of a row and waits for its drawer. */
export async function openHistory(key: Key, platform: string): Promise<HTMLElement> {
  await click(button(row(key), `历史 ${platform}`));
  const drawer = await dialog(`版本历史 · ${platform}`);
  expect(drawer.closest('.ant-drawer'), 'history is an antd Drawer').not.toBeNull();
  return drawer;
}

/** Version cards: list items of the drawer that hold a 「{平台} 版本 n」 preview. */
export function versionCards(scope: HTMLElement, platform: string): Map<number, HTMLElement> {
  const pattern = new RegExp(`^${escape(platform)} 版本 (\\d+)，浅色底 16、24、32px$`);
  const cards = new Map<number, HTMLElement>();
  for (const item of within(scope).queryAllByRole('listitem')) {
    const numbers = new Set(
      Array.from(item.querySelectorAll('[role="img"]'), nameOf).flatMap((name) => {
        const match = pattern.exec(name);
        return match === null ? [] : [Number(match[1])];
      }),
    );
    if (numbers.size !== 1) continue;
    const [n] = [...numbers];
    // The innermost list item holding exactly one version is its card.
    if (!cards.has(n!) || cards.get(n!)!.contains(item)) cards.set(n!, item);
  }
  return cards;
}

export async function cardsShown(
  drawer: HTMLElement,
  platform: string,
  expected: readonly number[],
): Promise<Map<number, HTMLElement>> {
  await waitFor(() => expect([...versionCards(drawer, platform).keys()]).toEqual(expected));
  return versionCards(drawer, platform);
}

export function successBar(sentence: string): HTMLElement {
  const bars = Array.from(mainElement().querySelectorAll<HTMLElement>('.ant-alert')).filter((bar) =>
    squash(bar.textContent).includes(squash(sentence)),
  );
  expect(bars, `antd Alert 「${sentence}」 in the main area`).toHaveLength(1);
  return bars[0]!;
}

export async function waitSuccess(sentence: string): Promise<HTMLElement> {
  await waitFor(() => successBar(sentence));
  return successBar(sentence);
}

/**
 * What sets the highlighted row apart from all other rows: a class only it carries (rowClassName)
 * or an inline background on the row or its cells that no other row has (onRow / onCell style).
 */
export function highlightOnly(key: Key): string[] {
  const marks = (target: HTMLElement): string[] => [
    ...Array.from(target.classList, (name) => `class:${name}`),
    ...[target, ...Array.from(target.children)].flatMap((node) => {
      const style = (node as HTMLElement).style;
      const background = style.backgroundColor || style.background;
      return background === '' ? [] : [`background:${background}`];
    }),
  ];
  const others = KEYS.filter((other) => other !== key).map((other) => new Set(marks(row(other))));
  return [...new Set(marks(row(key)))].filter((mark) => others.every((set) => !set.has(mark)));
}

export function breadcrumb(): string[] {
  return within(screen.getByRole('navigation', { name: '面包屑' }))
    .getAllByRole('listitem')
    .map((node) => clean(node.textContent))
    .filter((text) => text !== '' && text !== '/');
}

export function writes(server: FakeServer) {
  return server.log.filter((request) => request.method !== 'GET');
}

/** Lets pending promises (a released late answer) settle inside act. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
