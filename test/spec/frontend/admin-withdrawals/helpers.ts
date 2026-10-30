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
  LIST,
  createServer,
  snapshot as snapshotOf,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `withdrawals`, the
// detail at withdrawals/{id}): no import of a page module, so a missing page is an assertion
// failure, not an import error. antd's first Table / Tabs / Select render of a file is slow in
// jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → filter → detail). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or neither withdraw.review nor fund.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:提现|数据|记录)/;
/** The notice of an unknown withdrawal (20001 [withdrawal_id]). */
export const NOT_FOUND = /不存在|未找到|找不到|无此/;

/** The row entry of the detail (design §2 / §6: 【详情】, read 「查看 W… 详情」). */
export const DETAIL_ENTRY = /^(?:详情|查看详情|查看.*详情|查看)$/;
export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/**
 * Write entries that have no contract in this task (approve, reject, batch approve, batch manual
 * and automatic payout, one-click batch, manual success, execute, cancel a WeChat transfer,
 * export, risk flag recalculation, settings save): never usable on this page.
 */
export const WRITE =
  /^(?:审核通过|通过审核|驳回|批量通过|批量手动打款|批量自动打款|一键组批|手动成功|录入并确认|执行打款|撤销微信转账|导出(?!记录)|重新计算|恢复默认值)/;

/** Field labels (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  reviewMode: /审核方式|review_mode/i,
  channel: /收款方式|payout_channel|payout_method/i,
  outBizNo: /提现单号|out_biz_no/i,
  createdFrom: /起始|开始|^start\b|created_from/i,
  createdTo: /截止|结束|^end\b|created_to/i,
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  readonly planned?: ReadonlySet<string>;
  /** The console route without the leading slash; defaults to the list (`withdrawals`). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 提现审核 (or a detail route) over the fake server. */
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
        initialRoute: { menuId: options.route ?? 'withdrawals' },
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
/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;
/** The text nodes of `node` joined with spaces (cells and fields do not run into each other). */
export function textOf(node: Node): string {
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
/**
 * `text` shows the yuan amount `yuan` (written out by hand in the test, e.g. '1234.56'), not as
 * part of a longer number; thousands separators and the yuan sign are ignored.
 */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?![\\d])`).test(moneyText(text));
}

// ---- the 审核列表 ---------------------------------------------------------------------------

export const LIST_TAB = '审核列表';

/** Tabs of the page whose name starts with `name` (a count badge may follow). */
export function tabsNamed(name: string, root: HTMLElement = main()): HTMLElement[] {
  return within(root)
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(name) ||
        squash(tab.getAttribute('aria-label')).startsWith(name),
    );
}
/** Where the review list lives: the panel of the 审核列表 tab, or the main area without it. */
export function scope(): HTMLElement {
  const found = tabsNamed(LIST_TAB);
  if (found.length === 0) return main();
  expect(found, `tab ${LIST_TAB}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  return main();
}
/**
 * Shows the review list (its tab when the page has tabs) and, when `number` is given, waits for
 * the row of that withdrawal number.
 */
export async function openList(server: Server, number?: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      tabsNamed(LIST_TAB).length > 0 || server.reads().length > 0,
      'the 审核列表 tab or a read of the list',
    ).toBe(true),
  );
  const tab = tabsNamed(LIST_TAB)[0];
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') await click(tab);
  if (number !== undefined) await waitFor(() => expect(rowsOf(scope(), [number])).toHaveLength(1));
  return scope();
}

// ---- rows ----------------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text holds every token of `words`. */
export function rowsOf(root: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map(token);
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = textOf(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** The one row of the list for the withdrawal number `number`. */
export function rowOf(number: string): HTMLElement {
  const found = rowsOf(scope(), [number]);
  expect(found, `one row for ${number}`).toHaveLength(1);
  return found[0]!;
}
/** The withdrawal numbers among `numbers` that have a row in the list. */
export function listed(numbers: readonly string[]): string[] {
  return numbers.filter((number) => rowsOf(scope(), [number]).length > 0);
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

/**
 * The page offers no usable write entry; pressing any (disabled) one sends nothing but GETs.
 * Returns the names of the write entries found (all disabled).
 */
export async function assertReadOnly(server: Server, root: HTMLElement = main()) {
  const found = actions(root, WRITE);
  const names = found.map(
    (node) => squash(node.textContent) || squash(node.getAttribute('aria-label')),
  );
  expect(
    usable(root, WRITE).map((node) => squash(node.textContent)),
    'no usable write entry (approve / reject / batch / payout / export …)',
  ).toEqual([]);
  for (const node of found) if (node.isConnected) await click(node);
  await settled(server);
  expect(server.writes(), 'no request other than GET').toEqual([]);
  return names;
}
/** Requests that are not one of the two reads of this task (list, detail). */
export function otherWithdrawalRequests(server: Server): RequestLog[] {
  const allowed = /^\/admin\/v1\/withdrawals(?:\/[^/]+)?$/;
  return server.log.filter(
    (request) =>
      request.method !== 'GET' ||
      (request.path.startsWith(LIST) && !allowed.test(request.path)) ||
      /payout|export|auto-payout|risk-flags|reveal/.test(request.path),
  );
}

// ---- dialogs and the detail ----------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
  }
  return true;
}
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
}
/**
 * Where the detail of `number` is shown: an open drawer / dialog holding it, else the main area
 * (the detail route withdrawals/{id}).
 */
export function detailArea(number: string): HTMLElement {
  const pattern = token(number);
  const drawers = openDialogs().filter((node) => pattern.test(textOf(node)));
  return drawers[0] ?? main();
}
/** Waits for the detail read of `id` and for the detail of `number` to be shown. */
export async function detailShown(server: Server, id: string, number: string) {
  await waitFor(() => expect(server.detailReads(id).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(textOf(detailArea(number))).toMatch(token(number)));
  return detailArea(number);
}
/** Opens the detail of the row `number` through its 【详情】 entry. */
export async function openDetail(server: Server, number: string, id: string) {
  await openList(server, number);
  const entries = usable(rowOf(number), DETAIL_ENTRY);
  expect(entries.length, `a usable 【详情】 for ${number}`).toBeGreaterThan(0);
  const named = entries.find((node) => /^详情$/.test(squash(node.textContent)));
  await click(named ?? entries[0]!);
  return detailShown(server, id, number);
}

// ---- fields --------------------------------------------------------------------------------

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

/** Types a date (YYYY-MM-DD) into a plain input or an antd picker input. */
export async function fillDate(input: HTMLElement, value: string): Promise<void> {
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
/** The application-time start / end input of the filter. */
export function dateField(which: 'from' | 'to'): HTMLInputElement | HTMLTextAreaElement {
  return textbox(scope(), which === 'from' ? LABEL.createdFrom : LABEL.createdTo);
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

// ---- requests ------------------------------------------------------------------------------

/** Keys of a list request's query that listAdminWithdrawals does not take. */
export function extraParams(request: RequestLog, allowed: readonly string[]): string[] {
  return Object.keys(request.query).filter((name) => !allowed.includes(name));
}
