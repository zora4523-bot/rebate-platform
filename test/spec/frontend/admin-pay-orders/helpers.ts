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

// The page is reached only through the real shell (createAdminShell, menu id `pay-orders`, or the
// detail address pay-orders/{pay_order_id}): no import of a page module, so a missing page is an
// assertion failure, not an import error. antd's first Table / Tabs / Select render of a file is
// slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → detail, tab → filter). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or no pay.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:支付单|异常|差错|数据|记录)/;
/** A pay order the server does not know, or of another app (20001 with fields [pay_order_id]). */
export const NOT_FOUND = /不存在|未找到|找不到|没有找到|无此/;
/** What a missing value must not turn into. */
export const NOT_A_VALUE = /NaN|undefined|null|admin_dict/;
/** BR-PAY-07: the money received does not go into any user balance (key phrase only). */
export const BALANCE_NOTE = /(?:不进|不进入|不计入|不入)用户余额/;

/** The row entry of a pay order (design: 【详情】). */
export const DETAIL_ENTRY = /^(?:详情|查看|查看详情)$/;
export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/**
 * Writes and exports not in this part (refund, query now, resolve, export, the manual download and
 * check of the reconciliation, closing or handling a difference): none may be usable here.
 */
export const WRITE_ACTIONS =
  /^(?:发起退款|原路退款|退款|立即查询|查询渠道|人工处置|处置|导出|手动下载并核对|下载并核对|重新核对|关闭差错|关闭|结案|登记异常收款|处理)(?!中|结果|单|记录|时间)/;
/** The step-up dialog (none on this page). */
export const STEP_UP = /二次验证|动态码/;

/** The tabs of the page (a count may follow the name). */
export const TAB = {
  orders: /^支付单(?:\d+|[（(]\d+[)）])?$/,
  anomalies: /^异常收款(?:\d+|[（(]\d+[)）])?$/,
  recon: /^收款对账(?:\d+|[（(]\d+[)）])?$/,
} as const;

/** Field labels of the filters (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  status: /^(?!.*(?:人工|处置|退款)).*状态/,
  channel: /渠道/,
  outTradeNo: /单号|out_trade_no/i,
  user: /用户|user_id/i,
  diffType: /类型/,
} as const;

/** Column titles of the pay order list (spaces removed). */
export const ORDER_COLUMN = {
  user: /^用户/,
  biz: /^业务/,
  channel: /^(?:支付|收款)?渠道(?!交易|单号|流水|订单)/,
  amount: /^(?:订单|支付|应付)?金额/,
  refunded: /^已退/,
  status: /^(?:支付单|订单|支付)?状态/,
} as const;
/** Column titles of the pay anomaly list. */
export const ANOMALY_COLUMN = {
  channel: /^(?:支付|收款)?渠道(?!交易|单号|流水|订单)/,
  tradeNo: /^(?:渠道)?交易号|^渠道(?:交易|流水)号/,
  amount: /^(?:收款|异常|收到)?金额/,
  refunded: /^已退/,
  status: /^(?:处理)?状态/,
} as const;
/** Column titles of the R4 difference list. */
const UNIT = '(?:[（(][^)）]*[)）])?';
export const DIFF_COLUMN = {
  type: /^(?:差错)?类型/,
  expected: /^(?:我方|应收|账面|系统)/,
  actual: new RegExp(`^(?:渠道|通道|账单|实收|实际)(?:侧|方)?(?:金额)?${UNIT}$`),
  diff: new RegExp(`^(?:差额|差值|差异)(?:金额)?${UNIT}$`),
  status: /^(?:处理)?状态/,
} as const;
/** Labels of the pay order's amounts on the detail (contract amount_fen / refunded_fen). */
export const AMOUNT_LABEL = {
  amount: /^(?:订单|应付|支付)?金额/,
  refunded: /^已退/,
} as const;
/** Section titles of the detail. */
export const SECTION = {
  refunds: /退款记录/,
  attempts: /请求|查询记录|渠道记录/,
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
  /** The address without its leading slash; defaults to the list (pay-orders). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 支付单 (or a detail address) over the fake server. */
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
        account: { username: 'fin-pay', displayName: '财务' },
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
/** A date (YYYY-MM-DD) on its own, not inside a longer date. */
export function dayToken(day: string): RegExp {
  return new RegExp(`(?<![\\d-])${escape(day)}(?![\\d-])`);
}
/** The text nodes of `node` joined with spaces (a row's cells do not run into each other). */
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}

// ---- amounts -------------------------------------------------------------------------------

/** Text without thousands separators and yuan signs; a minus sign stays on its number. */
function plain(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[,，¥￥]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/-\s+/g, '-')
    .replace(/\s+/g, ' ');
}
/**
 * `text` shows the yuan amount `yuan` (hand-computed from fen, two decimals). A positive `yuan`
 * does not match the same digits after a minus sign, so 45.60 and -45.60 differ.
 */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?!\\d)`).test(plain(text));
}

// ---- where the page shows its content ------------------------------------------------------

function hiddenPanel(node: HTMLElement): boolean {
  return (
    node.getAttribute('aria-hidden') === 'true' ||
    node.hidden ||
    node.style.display === 'none' ||
    /(?:^|\s)\S*tabpane-hidden(?:\s|$)/.test(node.className) ||
    (node.classList.contains('ant-tabs-tabpane') &&
      !node.classList.contains('ant-tabs-tabpane-active'))
  );
}
/**
 * The active tab panel of the page when it holds the content, else the main area. Panels of tabs
 * visited before may stay mounted (hidden); lookups stay inside the shown one.
 */
export function scope(): HTMLElement {
  const area = main();
  const shown = Array.from(area.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter(
    (node) => !hiddenPanel(node) && squash(node.textContent) !== '',
  );
  return shown.length === 1 ? shown[0]! : area;
}

// ---- tabs ----------------------------------------------------------------------------------

/** The tab (or tab-like control) of the main area named `name`. */
export function tabs(name: RegExp): HTMLElement[] {
  const area = main();
  const named = (node: HTMLElement): boolean =>
    name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label')));
  const roleTabs = Array.from(area.querySelectorAll<HTMLElement>('[role="tab"]')).filter(named);
  if (roleTabs.length > 0) return roleTabs;
  return Array.from(
    area.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], [role="link"], [role="radio"], .ant-segmented-item, label',
    ),
  ).filter(named);
}
/** Opens the tab `name` of the page. */
export async function openTab(name: RegExp): Promise<void> {
  await waitFor(() => expect(tabs(name).length, `a tab ${String(name)}`).toBeGreaterThan(0));
  await click(tabs(name)[0]!);
  await settle();
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
/** Rows of the shown list holding the whole word `word` (an order or trade number). */
export function rowsOf(word: string): HTMLElement[] {
  return rowsWith(scope(), [token(word)]);
}
export function rowOf(word: string): HTMLElement {
  const found = rowsOf(word);
  expect(found, `one row for ${word}`).toHaveLength(1);
  return found[0]!;
}
/** Rows of the shown list for the bill date `day` (YYYY-MM-DD). */
export function dayRows(day: string): HTMLElement[] {
  return rowsWith(scope(), [dayToken(day)]);
}
export function dayRow(day: string): HTMLElement {
  const found = dayRows(day);
  expect(found, `one row for ${day}`).toHaveLength(1);
  return found[0]!;
}
/** Rows anywhere on the page whose text (spaces removed) contains `text` (a time as shown). */
export function rowsContaining(text: string): HTMLElement[] {
  const matching = Array.from(document.body.querySelectorAll<HTMLElement>(ROW)).filter((node) =>
    squash(textOf(node)).includes(text),
  );
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}

/** Waits for the one row of `word` in the shown list. */
export async function listed(word: string): Promise<HTMLElement> {
  await waitFor(() => expect(rowsOf(word), `list row ${word}`).toHaveLength(1));
  return rowOf(word);
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

// ---- labelled items (detail) ---------------------------------------------------------------

const DIGIT = /\d/;
/**
 * Texts of the items labelled `label` in `root` (a description item, a statistic, a label with
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
/** Types `value` into a text input. */
export async function fill(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
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

/** Presses 【查询】 of the shown filter. */
export async function query(): Promise<void> {
  await click(action(scope(), QUERY));
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
/** Every read sent asks for a page size between 1 and 200 and only the operation's parameters. */
export function assertPaging(
  reads: readonly { query: Record<string, string> }[],
  allowed: readonly string[],
): void {
  for (const read of reads) {
    expect(extraParams(read.query, allowed)).toEqual([]);
    const size = Number(read.query['page_size'] ?? '20');
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(200);
  }
}
