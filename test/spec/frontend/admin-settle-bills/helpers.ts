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
  MENU_ID,
  VERIFY,
  createServer,
  namePattern,
  snapshot as snapshotOf,
  type DictField,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `settle-bills`, or
// the detail address settle-bills/{bill_id}): no import of a page module, so a missing page is an
// assertion failure, not an import error. antd's first Table / Drawer / Select render of a file is
// slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → detail → batch items). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or neither settle.bill nor fund.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:账单|数据|记录)/;
/** A bill or batch the server does not know (20001 with fields [bill_id] / [batch_id]). */
export const NOT_FOUND = /不存在|未找到|找不到|没有找到|无此/;
/** The 「功能开发中」 placeholder of a planned operation (apps/admin/src/texts/shell.ts). */
export const PLANNED = '功能开发中';
/** What a missing value must not turn into. */
export const NOT_A_VALUE = /NaN|undefined|null|admin_dict/;

/** The row entry of a bill (design §2: 【查看】). */
export const VIEW_ENTRY = /^(?:查看|详情|查看详情)$/;
/** The entry of a batch's items (design §2: 【明细】). */
export const ITEMS_ENTRY = /^(?:明细|查看明细|批次明细)$/;
export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/** Writes without a contract yet (and the export): none may be usable on this page. */
export const WRITE_ACTIONS =
  /^(?:确认立即执行|立即执行|定时执行|确认结算|确认|撤销定时|驳回|继续执行|发起补充批次|生成补充批次|上传结算明细|重新上传|确认导入|导入|导出)/;
/** The step-up dialog (none on this page). */
export const STEP_UP = /二次验证|动态码/;

/** Field labels of the list filter (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  billFrom: /(?:账单月|月份).*(?:起|从|开始)|起始|开始|bill_from/i,
  billTo: /(?:账单月|月份).*(?:止|至|到|结束)|截止|结束|bill_to/i,
  status: /状态/,
} as const;

/** Column titles of the bill list (spaces removed; design §2 列表). */
export const COLUMN = {
  status: /^(?:账单)?状态/,
  generated: /^(?:生成|出账)时间/,
  orders: /^子订单/,
  commission: /佣金/,
  beneficiary: /^受益人/,
  retained: /留存/,
  errors: /^差错/,
  held: /^暂缓/,
} as const;
/** Column titles of the batch table (design §2 结算批次). */
export const BATCH_COLUMN = {
  kind: /^(?:批次)?类型/,
  status: /^(?:批次)?状态/,
  mode: /^(?:结算|执行)方式/,
  confirmer: /^确认人/,
} as const;
/** Column titles of the batch items (design §2 批次明细). */
export const ITEM_COLUMN = {
  type: /^(?:明细)?类型/,
  result: /^(?:处理|执行|入账)?结果/,
  reason: /原因/,
} as const;
/** Labels of the bill's statistics on the detail (design §2 统计卡). */
export const STAT = {
  orders: /^子订单(?:数|总数)?/,
  commission: /^(?:联盟)?结算佣金/,
  beneficiary: /^受益人(?:份额)?/,
  retained: /^平台留存/,
  errors: /^差错(?:单)?/,
  held: /^暂缓/,
} as const;
/** Labels of the batch items filter (contract item_type / result). */
export const ITEM_LABEL = {
  type: /类型/,
  result: /结果/,
} as const;

/**
 * `text` shows `code` of `field` as the console dictionary has it: one of its names, or the code
 * as a whole word when the dictionary has no row (read when the test runs).
 */
export function showsName(text: string, field: DictField, code: string): boolean {
  return namePattern(field, code).test(squash(text)) || namePattern(field, code).test(text);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  readonly planned?: ReadonlySet<string>;
  /** The address without its leading slash; defaults to the list (settle-bills). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 月结账单 (or a detail address) over the fake server. */
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
        initialRoute: { menuId: options.route ?? MENU_ID },
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

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** `word` as a whole token (not inside a longer [A-Za-z0-9_] run). */
export function token(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`);
}
/** An id as shown: its first 8 characters as a token (the page may shorten long ids). */
export function idToken(id: string): RegExp {
  return token(id.slice(0, 8));
}
/** A bill month (YYYY-MM) on its own, not the year-month of a date such as 2026-08-24. */
export function monthToken(month: string): RegExp {
  return new RegExp(`(?<![\\d-])${escape(month)}(?!-?\\d)`);
}
/** The text nodes of `node` joined with spaces (a row's cells do not run into each other). */
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}

// ---- amounts and counts --------------------------------------------------------------------

/** Text without thousands separators and yuan signs; a minus sign stays on its number. */
function plain(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[,，¥￥]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/-\s+/g, '-')
    .replace(/\s+/g, ' ');
}
/** `text` shows the yuan amount `yuan` (hand-computed from fen, two decimals). */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?!\\d)`).test(plain(text));
}
/** `text` shows the count `count` as a number of its own (not part of a date or an amount). */
export function showsCount(text: string | null | undefined, count: string): boolean {
  return new RegExp(`(?<![\\d.:-])${escape(count)}(?![\\d.:])`).test(plain(text));
}

// ---- rows and cells ------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text matches every pattern. */
export function rowsWith(root: ParentNode, patterns: readonly RegExp[]): HTMLElement[] {
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = textOf(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** Rows of the bill list (in the main area) for the bill month `month`. */
export function billRows(month: string): HTMLElement[] {
  return rowsWith(main(), [monthToken(month)]);
}
export function billRow(month: string): HTMLElement {
  const found = billRows(month);
  expect(found, `one list row for ${month}`).toHaveLength(1);
  return found[0]!;
}
/** Rows anywhere on the page (main area, drawer or dialog) for the id `id`. */
export function idRows(id: string): HTMLElement[] {
  return rowsWith(document.body, [idToken(id)]);
}
export function idRow(id: string): HTMLElement {
  const found = idRows(id);
  expect(found, `one row for ${id.slice(0, 8)}`).toHaveLength(1);
  return found[0]!;
}

/** Text of the cell of `row` under the one column whose title matches `title`. */
export function cellText(row: HTMLElement, title: RegExp): string {
  let header: HTMLElement | null = null;
  for (let node = row.parentElement; node !== null && header === null; node = node.parentElement)
    header = node.querySelector<HTMLElement>('thead tr');
  expect(header, 'a header row with column titles').not.toBeNull();
  const titles = Array.from(header!.children, (cell) => squash(cell.textContent));
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = row.children[indexes[0]!];
  expect(cell, String(title)).toBeDefined();
  return textOf(cell!);
}

// ---- labelled items (statistics) -----------------------------------------------------------

const DIGIT = /\d/;
/**
 * Texts of the items labelled `label` in `root` (a statistic, a description item, a label with
 * its value): for each innermost visible element outside a table header whose text starts with
 * `label`, the label with the first sibling after it (or after an ancestor) that holds a number.
 */
export function labelledTexts(root: HTMLElement, label: RegExp): string[] {
  const matching = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (node) =>
      node.closest('thead, [role="columnheader"]') === null &&
      visible(node) &&
      label.test(squash(node.textContent)),
  );
  const labels = matching.filter(
    (node) => !Array.from(node.children).some((child) => label.test(squash(child.textContent))),
  );
  return labels.map((node) => {
    if (DIGIT.test(squash(node.textContent).replace(label, ''))) return textOf(node);
    let current: Element | null = node;
    while (current !== null && current !== root) {
      for (let next = current.nextElementSibling; next !== null; next = next.nextElementSibling)
        if (DIGIT.test(next.textContent ?? '')) return `${textOf(current)} ${textOf(next)}`;
      current = current.parentElement;
    }
    return textOf(node);
  });
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
/** The usable action named `name` closest to `node` (in its nearest ancestor holding one). */
export function nearestUsable(node: HTMLElement, name: RegExp): HTMLElement | undefined {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const found = usable(parent, name);
    if (found.length > 0) return found[0];
  }
  return undefined;
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
export function openDialogs(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(visible);
}
/** Title of a dialog (aria-label, aria-labelledby, antd titles). */
function titleOf(node: HTMLElement): string {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const texts = ids.map((id) => {
    const inside = node.querySelector(`[id="${id}"]`);
    return (inside ?? document.getElementById(id))?.textContent ?? '';
  });
  texts.push(node.getAttribute('aria-label') ?? '');
  texts.push(node.querySelector('.ant-modal-title, .ant-drawer-title')?.textContent ?? '');
  return texts.join(' ');
}
export function stepUpOpen(): boolean {
  return openDialogs().some((node) => STEP_UP.test(titleOf(node)));
}
/**
 * Where a bill's detail is shown: the innermost open drawer / dialog holding `pattern`, else the
 * main area (a detail page of its own).
 */
export function detailScope(pattern: RegExp): HTMLElement {
  const found = openDialogs().filter((node) => pattern.test(textOf(node)));
  const innermost = found.filter(
    (node) => !found.some((other) => other !== node && node.contains(other)),
  );
  return innermost[0] ?? main();
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
/** The one text input labelled (or with a placeholder) matching `label` in `root`. */
export function textbox(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  const found = [...new Set([...labelled, ...placeholders])].filter(isTextField);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}
/** Types a bill month (YYYY-MM) into a plain input or an antd month picker input. */
export async function fillMonth(input: HTMLElement, value: string): Promise<void> {
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
export function monthField(which: 'from' | 'to'): HTMLInputElement | HTMLTextAreaElement {
  return textbox(main(), which === 'from' ? LABEL.billFrom : LABEL.billTo);
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
/** The one select (antd Select or native) labelled `label` inside `root`. */
export function combobox(root: HTMLElement, label: RegExp): HTMLElement {
  const combos = within(root).queryAllByRole('combobox', { name: label });
  expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
  return combos[0]!;
}
/**
 * Chooses `option` in the select (antd Select or native) labelled `label` inside `root`; returns
 * the texts of every option that was offered.
 */
export async function choose(root: HTMLElement, label: RegExp, option: RegExp): Promise<string[]> {
  const combo = combobox(root, label);
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

/** Presses 【查询】 of the filter. */
export async function query(): Promise<void> {
  await click(action(main(), QUERY));
  await settle();
}

const NEXT =
  '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"], .ant-pagination [title="2"]';
/** Clicks 「下一页」 (or page 2) of the pagination closest to `node`. */
export async function nextPageNear(node: HTMLElement): Promise<void> {
  let next: HTMLElement | null = null;
  let parent = node.parentElement;
  while (parent !== null && next === null) {
    next = parent.querySelector<HTMLElement>(NEXT);
    parent = parent.parentElement;
  }
  expect(next, 'a pagination control for page 2').not.toBeNull();
  await click(next!);
}

// ---- flows ---------------------------------------------------------------------------------

/** Waits for the list row of `month`. */
export async function listed(month: string): Promise<HTMLElement> {
  await waitFor(() => expect(billRows(month), `list row ${month}`).toHaveLength(1));
  return billRow(month);
}

/**
 * Opens the detail of `month` from its list row (【查看】), waits for its read and for the row of
 * `batchId`; returns where the detail is shown.
 */
export async function openBill(
  server: Server,
  month: string,
  batchId: string,
): Promise<HTMLElement> {
  const row = await listed(month);
  const entries = usable(row, VIEW_ENTRY);
  expect(entries.length, `a usable 【查看】 for ${month}`).toBeGreaterThan(0);
  await click(entries[0]!);
  await waitFor(() => expect(server.billReads(month).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(idRows(batchId), `batch row ${batchId.slice(0, 8)}`).toHaveLength(1));
  return detailScope(idToken(batchId));
}

/** Presses 【明细】 of the batch row `batchId` and waits for the items read. */
export async function openItems(server: Server, batchId: string): Promise<void> {
  const entries = usable(idRow(batchId), ITEMS_ENTRY);
  expect(entries.length, `a usable 【明细】 for ${batchId.slice(0, 8)}`).toBeGreaterThan(0);
  await click(entries[0]!);
  await waitFor(() => expect(server.itemReads(batchId).length).toBeGreaterThan(0));
  await settled(server);
}

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification, antd Alert / Result / Empty. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-result, .ant-empty';

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
export interface Before {
  readonly nodes: ReadonlyMap<Text, string>;
  readonly main: string;
}
/** Every text node on the page with its text, and the main area's text, taken before an action. */
export function before(): Before {
  return {
    nodes: new Map(textNodes().map((node): [Text, string] => [node, node.data])),
    main: squash(main().textContent),
  };
}
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"]') !== null) return true;
  return element.closest(NOTICES) !== null;
}
/** Text new (or changed) since `prior`, in notices and in dialogs / drawers. */
export function freshText(prior: Before): string {
  return squash(
    textNodes()
      .filter((node) => prior.nodes.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}
/**
 * The operator was told `pattern` after the action: in a new notice / dialog text, or in the main
 * area that did not say it before.
 */
export function told(prior: Before, pattern: RegExp): boolean {
  if (pattern.test(freshText(prior))) return true;
  return !pattern.test(prior.main) && pattern.test(squash(main().textContent));
}

// ---- requests ------------------------------------------------------------------------------

/** No step-up was asked for (no verify request, no step-up dialog). */
export function assertNoStepUp(server: Server): void {
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(stepUpOpen(), 'no step-up dialog').toBe(false);
}
/** Keys of a request's query that the operation does not take. */
export function extraParams(query: Record<string, string>, allowed: readonly string[]): string[] {
  return Object.keys(query).filter((name) => !allowed.includes(name));
}
