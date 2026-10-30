import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  BASE_URL,
  VERIFY,
  createServer,
  detailPath,
  snapshot as snapshotOf,
  yuan,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `recon`): no import
// of a page module, so a missing page is an assertion failure, not an import error. antd's first
// Table / Tabs / Drawer / Modal / Select render of a file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → drawer → dialog → write → list). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or neither fund.recon nor fund.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** The 20902 notice: the difference was handled meanwhile, refresh. */
export const CONFLICT = /已变化|已变更|已被.*处理|他人处理|冲突|刷新后重试|已重新读取|已刷新/;
/** The 20901 notice: the same request key with another body. */
export const CHANGED = /有变化|已变化|重新提交|内容.*不一致|冲突/;
/** The 40901 notice: the same request is still being handled. */
export const RUNNING = /处理中|进行中|稍后|正在/;
/** A failure of the list read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:差错|数据|记录)/;

/** The row entry of the drawer (design §2: 【处理】【详情】). */
export const DETAIL_ENTRY = /^(?:详情|处理|查看)$/;
/** The close entry (design §2: 【已关闭（不处理）】, fund.recon). */
export const CLOSE_ENTRY = /^已关闭[（(]不处理[)）]$/;
/** The submit button of the close dialog. */
export const SUBMIT = /^(?:确认|确定|提交|已关闭[（(]不处理[)）])/;
export const CANCEL = /^取消$/;
export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/** The step-up dialog (none on this page). */
export const STEP_UP = /二次验证|动态码/;

/** Field labels (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  type: /类型/,
  source: /来源/,
  status: /状态/,
  ref: /关联单据|单据号|ref_id/i,
  reason: /原因/,
  periodFrom: /(?:周期|期间).*(?:起|从|开始)|(?:起始|开始)|period_from/i,
  periodTo: /(?:周期|期间).*(?:止|至|到|结束)|(?:截止|结束)|period_to/i,
} as const;

/** Column titles of the list (spaces removed; matched at the start of the title). */
export const COLUMN = {
  type: /^(?:差错单?)?类型/,
  source: /^来源/,
  period: /^(?:对账)?周期/,
  ref: /^关联/,
  expected: /^我方/,
  actual: /^对方/,
  diff: /^差额/,
  status: /^(?:差错单?)?状态/,
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  readonly planned?: ReadonlySet<string>;
}

/** Mounts the real admin shell on 资金 / 对账与差错 over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const onError = vi.fn();
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => 'example-admin-token',
    onError,
  });
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'recon' },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
        ...(options.planned === undefined ? {} : { plannedOperations: options.planned }),
      }),
    );
  });
  await settle();
  return { server, directFetch, onError };
}

/** The shell's main landmark (looked up without the accessibility filter). */
export function main(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1)
    await act(async () => {
      await Promise.resolve();
    });
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await settle();
}
export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}
export async function fill(node: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(node, { target: { value } });
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** `word` as a whole token (not inside a longer [A-Za-z0-9_] run). */
function token(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`);
}
/** The text nodes of `node` joined with spaces (a row's cells do not run into each other). */
function spacedText(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}

// ---- amounts -------------------------------------------------------------------------------

/** Text without thousands separators and yuan signs; a minus sign stays on its number. */
export function moneyText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[,，¥￥]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/-\s+/g, '-')
    .replace(/\s+/g, ' ');
}
/** The text of `node` with its text nodes joined by spaces (for amounts in a drawer). */
export function textOf(node: Node): string {
  return spacedText(node);
}
/** `text` shows `fen` as yuan with two decimals (a negative with its minus sign). */
export function showsAmount(text: string | null | undefined, fen: number): boolean {
  const before = fen < 0 ? '(?<![\\d.])' : '(?<![\\d.-])';
  return new RegExp(`${before}${escape(yuan(fen))}(?!\\d)`).test(moneyText(text));
}

// ---- the 差错单 tab ------------------------------------------------------------------------

export const DIFFS_TAB = '差错单';
export const RUNS_TAB = '对账任务';

/** Tabs of the page whose name starts with `name` (a count badge may follow). */
export function tabsNamed(name: string): HTMLElement[] {
  return within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(name) ||
        squash(tab.getAttribute('aria-label')).startsWith(name),
    );
}
/** Where the 差错单 list lives: the panel of the 差错单 tab, or the main area without tabs. */
export function scope(): HTMLElement {
  const found = tabsNamed(DIFFS_TAB);
  if (found.length === 0) return main();
  expect(found, `tab ${DIFFS_TAB}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  const panels = within(main()).queryAllByRole('tabpanel');
  expect(panels, 'one visible tab panel').toHaveLength(1);
  return panels[0]!;
}
/**
 * Shows the 差错单 list (its tab when the page has tabs) and, when `ref` is given, waits for the
 * row referring to it.
 */
export async function openDiffs(server: Server, ref?: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      tabsNamed(DIFFS_TAB).length > 0 || server.reads().length > 0,
      'the 差错单 tab or a read of the list',
    ).toBe(true),
  );
  const tab = tabsNamed(DIFFS_TAB)[0];
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') await click(tab);
  if (ref !== undefined) await waitFor(() => expect(rowsOf(scope(), [ref])).toHaveLength(1));
  return scope();
}

// ---- rows and cells ------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text holds every token of `words`. */
export function rowsOf(root: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map(token);
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = spacedText(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** The one row of the list referring to `ref`. */
export function rowOf(ref: string): HTMLElement {
  const found = rowsOf(scope(), [ref]);
  expect(found, `one row for ${ref}`).toHaveLength(1);
  return found[0]!;
}

/** Column titles of the list's header row (spaces removed). */
function columnTitles(): string[] {
  const panel = scope();
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  return Array.from(header!.children, (cell) => squash(cell.textContent));
}
/** Text of the cell of the row `ref` under the one column whose title matches `title`. */
export function cellText(ref: string, title: RegExp): string {
  const titles = columnTitles();
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = rowOf(ref).children[indexes[0]!];
  expect(cell, `${ref} / ${String(title)}`).toBeDefined();
  return spacedText(cell!);
}

// ---- buttons -------------------------------------------------------------------------------

export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}
/** Buttons and links of `root` whose text or aria-label matches `name` (spaces ignored). */
export function actions(root: HTMLElement, name: RegExp): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  ).filter(
    (node) =>
      name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label'))),
  );
}
export function action(root: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(root, name);
  expect(found, `one action ${String(name)}`).toHaveLength(1);
  return found[0]!;
}
/** Usable (not disabled) actions of `root` named `name`. */
export function usable(root: HTMLElement, name: RegExp): HTMLElement[] {
  return actions(root, name).filter((node) => !isDisabled(node));
}

// ---- dialogs and drawers -------------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    // A closed antd Drawer may stay mounted (rc-drawer drops ant-drawer-open).
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (node.classList.contains('ant-popover-hidden')) return false;
  }
  return true;
}
const TITLES = '.ant-modal-title, .ant-drawer-title, .ant-modal-confirm-title';

/** Title of a dialog (aria-label, aria-labelledby looked up inside first, antd titles). */
export function titleOf(node: HTMLElement): string {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  // Under NODE_ENV=test every antd Modal / Drawer title gets the same id: look inside first.
  const texts = ids.map((id) => {
    const inside = node.querySelector(`[id="${id}"]`);
    return (inside ?? document.getElementById(id))?.textContent ?? '';
  });
  texts.push(node.getAttribute('aria-label') ?? '');
  texts.push(node.querySelector(TITLES)?.textContent ?? '');
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ');
}
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
}
export function stepUpOpen(): boolean {
  return openDialogs().some((node) => STEP_UP.test(titleOf(node)));
}

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** Text inputs and textareas of `root` labelled (or with a placeholder) matching `label`. */
export function textFields(
  root: HTMLElement,
  label: RegExp,
): (HTMLInputElement | HTMLTextAreaElement)[] {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  return [...new Set([...labelled, ...placeholders])].filter(isTextField);
}
/** The one text input (or textarea) labelled `label` in `root`. */
export function textbox(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(root, label);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}

/** Open dialogs holding the reason field of a close. */
export function reasonDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => textFields(node, LABEL.reason).length > 0);
}
/** The one open close dialog (the one with the reason field). */
export async function reasonDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(reasonDialogs(), 'one close dialog with a reason').toHaveLength(1));
  return reasonDialogs()[0]!;
}
/** Open dialogs / drawers (not the close dialog) that show `ref`. */
export function drawersOf(ref: string): HTMLElement[] {
  const pattern = token(ref);
  const found = openDialogs().filter(
    (node) => textFields(node, LABEL.reason).length === 0 && pattern.test(spacedText(node)),
  );
  return found.filter((node) => !found.some((other) => other !== node && node.contains(other)));
}

/** Opens the drawer of the row `ref` (its 【详情】, else 【处理】 / 【查看】). */
export async function openDetail(server: Server, ref: string, id: string): Promise<HTMLElement> {
  await openDiffs(server, ref);
  const row = rowOf(ref);
  const entries = usable(row, DETAIL_ENTRY);
  expect(entries.length, `a usable 【详情】 / 【处理】 for ${ref}`).toBeGreaterThan(0);
  const preferred = entries.find((node) => /^详情$/.test(squash(node.textContent))) ?? entries[0]!;
  await click(preferred);
  await waitFor(() => expect(server.requests('GET', detailPath(id)).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(drawersOf(ref), `the drawer of ${ref}`).toHaveLength(1));
  return drawersOf(ref)[0]!;
}

/** Usable 【已关闭（不处理）】 entries for `ref`: in its row and in its open drawer. */
export function closeEntries(ref: string): HTMLElement[] {
  const rows = rowsOf(scope(), [ref]);
  const scopes = [...rows, ...drawersOf(ref)];
  return [...new Set(scopes.flatMap((node) => usable(node, CLOSE_ENTRY)))];
}

/** Opens the close dialog of `ref` from its drawer (or its row). */
export async function openClose(server: Server, ref: string, id: string): Promise<HTMLElement> {
  if (drawersOf(ref).length === 0) await openDetail(server, ref, id);
  const entries = closeEntries(ref);
  expect(entries.length, `a usable 【已关闭（不处理）】 for ${ref}`).toBeGreaterThan(0);
  await click(entries[0]!);
  return reasonDialog();
}

/** Types `reason` into the close dialog and presses its submit button. */
export async function submitClose(modal: HTMLElement, reason: string): Promise<void> {
  await fill(textbox(modal, LABEL.reason), reason);
  await click(action(modal, SUBMIT));
  await settle();
}

// ---- fields --------------------------------------------------------------------------------

const EXPLAIN = '[role="alert"], .ant-form-item-explain-error';

/** Text of the error shown next to `input` (its form item or its error description). */
export function fieldError(input: HTMLElement): string {
  const ids = [input.getAttribute('aria-errormessage') ?? ''];
  // A description is an error only while the field is marked invalid (not a standing help text).
  if (input.getAttribute('aria-invalid') === 'true')
    ids.push(input.getAttribute('aria-describedby') ?? '');
  const texts = ids
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');
  const item = input.closest('.ant-form-item');
  const nearby = item === null ? [] : Array.from(item.querySelectorAll(EXPLAIN));
  for (const node of nearby) texts.push(node.textContent ?? '');
  return texts
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ');
}

function dropdownOf(combo: HTMLElement): HTMLElement | null {
  const id = combo.getAttribute('aria-controls') ?? combo.getAttribute('aria-owns');
  const list = id === null || id === '' ? null : document.getElementById(id);
  return list?.closest<HTMLElement>('.ant-select-dropdown') ?? null;
}
function optionNodes(combo: HTMLElement): HTMLElement[] {
  const own = dropdownOf(combo);
  const scopes =
    own !== null
      ? [own]
      : Array.from(
          document.querySelectorAll<HTMLElement>(
            '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
          ),
        );
  // rc-select's virtual accessibility mirror is not a click target: use the visible contents.
  return scopes.flatMap((node) =>
    Array.from(node.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}

/**
 * Chooses `option` in the select (antd Select or native) or radio group labelled `label` inside
 * `root`; returns the texts of every option that was offered.
 */
export async function choose(root: HTMLElement, label: RegExp, option: RegExp): Promise<string[]> {
  const combos = within(root).queryAllByRole('combobox', { name: label });
  if (combos.length > 0) {
    expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
    const combo = combos[0]!;
    if (combo instanceof HTMLSelectElement) {
      const offered = Array.from(combo.options);
      const target = offered.find((item) => option.test(item.text.trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
      await act(async () => {
        fireEvent.change(combo, { target: { value: target!.value } });
      });
      return offered.map((item) => item.text.trim());
    }
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
    let target: HTMLElement | undefined;
    let offered: string[] = [];
    await waitFor(() => {
      const nodes = optionNodes(combo);
      offered = nodes.map((node) => (node.textContent ?? '').trim());
      target = nodes.find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `option ${String(option)} of ${String(label)}`).toBeDefined();
    });
    await click(target!);
    return offered;
  }
  const groups = within(root).queryAllByRole('radiogroup', { name: label });
  expect(groups, `a select or radio group labelled ${String(label)}`).toHaveLength(1);
  const radios = within(groups[0]!).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a radio option ${String(option)} for ${String(label)}`).toHaveLength(1);
  await click(target[0]!);
  return radios.map(text);
}

/** Types a period (YYYY-MM or YYYY-MM-DD) into a plain input or an antd picker input. */
export async function fillPeriod(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input);
  });
}
/** The period start / end input of the filter. */
export function periodField(which: 'from' | 'to'): HTMLInputElement | HTMLTextAreaElement {
  const label = which === 'from' ? LABEL.periodFrom : LABEL.periodTo;
  return textbox(scope(), label);
}

/** Presses 【查询】 of the filter. */
export async function query(): Promise<void> {
  await click(action(scope(), QUERY));
  await settle();
}

/** Clicks the page control 「下一页」 (or the page number 2). */
export async function nextPage(): Promise<void> {
  const next =
    scope().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    ) ?? scope().querySelector<HTMLElement>('[title="2"]');
  expect(next, 'a page-number pagination control for page 2').not.toBeNull();
  await click(next!);
}

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification, antd Alert. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain';

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
export type TextSnapshot = ReadonlyMap<Text, string>;
/** Every text node on the page with its text, taken before an action. */
export function snapshotText(): TextSnapshot {
  return new Map(textNodes().map((node): [Text, string] => [node, node.data]));
}
/** Text the operator is told in: a notice, or a dialog / drawer. */
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"]') !== null) return true;
  return element.closest(NOTICES) !== null;
}
/**
 * Text that is new (or changed) since `before`, in notices and in dialogs / drawers; standing
 * text that was on the page before the action does not count.
 */
export function freshText(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}
/** `text` tells `count` released withdrawal holds (the number next to 冻结). */
export function tellsReleased(text: string, count: number): boolean {
  const n = `(?<!\\d)${count}(?!\\d)`;
  return new RegExp(`${n}\\D{0,12}冻结|冻结\\D{0,12}${n}`).test(text);
}

// ---- requests ------------------------------------------------------------------------------

/** The Idempotency-Key header of a close request (null when missing). */
export function requestKey(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}
/** A close request: bearer token, an Idempotency-Key, no step-up value, body {reason} only. */
export function assertClose(request: RequestLog, reason: string): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  const value = requestKey(request);
  expect(value, 'an Idempotency-Key header').not.toBeNull();
  expect(value!.trim(), 'a non-empty Idempotency-Key').not.toBe('');
  expect(request.headers.has('X-Step-Up-Token'), 'no step-up value').toBe(false);
  const body = request.body as Record<string, unknown> | undefined;
  expect(body, 'a JSON body').toBeDefined();
  expect(Object.keys(body!)).toEqual(['reason']);
  expect(typeof body!['reason']).toBe('string');
  expect((body!['reason'] as string).trim()).toBe(reason.trim());
}
/** No step-up was asked for (no verify request, no step-up dialog). */
export function assertNoStepUp(server: Server): void {
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(stepUpOpen(), 'no step-up dialog').toBe(false);
}
/** Keys of a list request's query that listAdminReconDiffs does not take. */
export function extraParams(request: RequestLog, allowed: readonly string[]): string[] {
  return Object.keys(request.query).filter((name) => !allowed.includes(name));
}
