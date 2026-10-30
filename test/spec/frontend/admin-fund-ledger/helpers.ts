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
  platformPattern,
  snapshot as snapshotOf,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `fund-ledger`): no
// import of a page module, so a missing page is an assertion failure, not an import error.
// antd's first Table render of a file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → filter → page). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or no fund.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A failure of a read. */
export const LOAD_FAILED = /失败|出错|错误/;
/** The empty list. */
export const EMPTY = /暂无|没有.*(?:快照|台账|数据|记录)/;
/** What a missing value must not turn into. */
export const NOT_A_VALUE = /NaN|undefined|null|admin_dict/;
/**
 * The hint of a snapshot whose waiting / estimated totals are not comparable with other days
 * (waiting_comparable=false; wording free, one of these phrases).
 */
export const NOT_COMPARABLE =
  /不可比|不具?可比|不能比较|无法比较|不可对比|仅供参考|超时|未确认|未按时/;

export const QUERY = /^(?:查询|搜索|筛选)$/;
export const RESET = /^重置$/;
export const RETRY = /重试/;
/**
 * Writes and exports not in this part (the two cash entries, the export and anything that would
 * write a snapshot): none may be usable here.
 */
export const WRITE_ACTIONS =
  /^(?:录入企业支付宝余额|录入联盟回款|录入|新增|登记|导出|生成快照|补写|重写|重算|重新生成|编辑|修改|删除|保存|提交|确认)/;
/** The step-up dialog (none on this page). */
export const STEP_UP = /二次验证|动态码/;

/** Field labels of the date range (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  dateFrom: /(?:日期|快照日?|账务日|会计日).*(?:起|从|开始)|起始|开始|date_from/i,
  dateTo: /(?:日期|快照日?|账务日|会计日).*(?:止|至|到|结束)|截止|结束|date_to/i,
} as const;

/**
 * Column titles of the daily ledger (spaces removed; a grouped column's title is its group's
 * title followed by its own). The date column may be titled 日期, 快照日(期), 会计日(期) and the like.
 */
export const COLUMN = {
  date: /^(?:快照|账务|记账|台账|会计)?日期?$/,
  available: /^(?!.*负).*(?:可用|正余额)/,
  negative: /负/,
  frozen: /冻结/,
  waiting: /待结算|已收货|待入账|waiting/i,
  estimated: /^(?!.*(?:已收货|待结算|待入账)).*预估/,
} as const;
/** The title of a receivable total column, if the page shows one (not required). */
export const RECEIVABLE_TOTAL = /^(?=.*(?:合计|总计|小计|总额))(?=.*(?:未回款|应收)).*$/;

/** The fake servers of the current test (every request of each is checked after the test). */
const mounted: Server[] = [];

afterEach(() => {
  const servers = mounted.splice(0);
  const stray = servers.flatMap((server) => server.others());
  cleanup();
  vi.unstubAllGlobals();
  // Every request of the whole test: only GET /admin/v1/asset-snapshots (and the shell's reads).
  expect(
    stray.map((request) => `${request.method} ${request.path}`),
    'only GET /admin/v1/asset-snapshots went out',
  ).toEqual([]);
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  readonly planned?: ReadonlySet<string>;
  /** The address without its leading slash; defaults to fund-ledger. */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 平台资金台账 over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  mounted.push(server);
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
        account: { username: 'fin-ledger', displayName: '财务' },
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
/** A day (YYYY-MM-DD) on its own, not inside a longer date or number. */
export function dayWord(day: string): RegExp {
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
 * does not match the same digits after a minus sign, so 23.00 and -23.00 differ.
 */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?!\\d)`).test(plain(text));
}
/** `text` shows `yuan` with or without a minus sign. */
export function showsEitherSign(text: string | null | undefined, yuan: string): boolean {
  const magnitude = yuan.replace(/^-/, '');
  return showsYuan(text, magnitude) || showsYuan(text, `-${magnitude}`);
}
/** Every amount-looking number of `text` (two decimals), as shown. */
export function amountsIn(text: string | null | undefined): string[] {
  return plain(text).match(/-?\d+\.\d{2}(?!\d)/g) ?? [];
}

// ---- table rows and cells ------------------------------------------------------------------

/** Body rows of the tables in the main area (antd's measure and placeholder rows aside). */
export function dataRows(): HTMLElement[] {
  return Array.from(main().querySelectorAll<HTMLElement>('tbody > tr')).filter(
    (row) =>
      row.getAttribute('aria-hidden') !== 'true' &&
      !row.classList.contains('ant-table-measure-row') &&
      !row.classList.contains('ant-table-placeholder') &&
      row.children.length > 1,
  );
}

/**
 * Column titles of the table holding `row`, one per body column (spaces removed): the header rows
 * are laid out by colspan / rowspan, so a grouped column's title is its group's title followed by
 * its own.
 */
export function columnTitles(row: HTMLElement): string[] {
  let head: HTMLElement | null = null;
  for (let node = row.parentElement; node !== null && head === null; node = node.parentElement)
    head = node.querySelector<HTMLElement>('thead');
  expect(head, 'a table header with column titles').not.toBeNull();
  const grid: string[][] = [];
  const headerRows = Array.from(head!.children).filter((node) => node.tagName === 'TR');
  headerRows.forEach((tr, rowIndex) => {
    const line = (grid[rowIndex] ??= []);
    let column = 0;
    for (const cell of Array.from(tr.children)) {
      while (line[column] !== undefined) column += 1;
      const across = Math.max(1, Number(cell.getAttribute('colspan') ?? '1') || 1);
      const down = Math.max(1, Number(cell.getAttribute('rowspan') ?? '1') || 1);
      const title = squash(cell.textContent);
      for (let r = 0; r < down; r += 1) {
        const target = (grid[rowIndex + r] ??= []);
        for (let c = 0; c < across; c += 1) target[column + c] = title;
      }
      column += across;
    }
  });
  const width = Math.max(0, ...grid.map((line) => line.length));
  return Array.from({ length: width }, (_, column) => {
    const parts: string[] = [];
    for (const line of grid) {
      const title = line[column] ?? '';
      if (title !== '' && parts.at(-1) !== title) parts.push(title);
    }
    return parts.join('');
  });
}
/** Index of the one column of `row`'s table whose title matches `title`. */
function columnIndex(row: HTMLElement, title: RegExp): number {
  const titles = columnTitles(row);
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)} among ${titles.join(' | ')}`).toHaveLength(1);
  return indexes[0]!;
}
/** Text of the cell of `row` under the one column whose title matches `title`. */
export function cellText(row: HTMLElement, title: RegExp): string {
  const cell = row.children[columnIndex(row, title)];
  expect(cell, String(title)).toBeDefined();
  return textOf(cell!);
}

/** Rows of the daily ledger whose date column shows `day`. */
export function dayRows(day: string): HTMLElement[] {
  const pattern = dayWord(day);
  return dataRows().filter((row) => pattern.test(cellText(row, COLUMN.date)));
}
export function dayRow(day: string): HTMLElement {
  const found = dayRows(day);
  expect(found, `one ledger row for ${day}`).toHaveLength(1);
  return found[0]!;
}
/** Waits for the one row of `day`. */
export async function listed(day: string): Promise<HTMLElement> {
  await waitFor(() => expect(dayRows(day), `ledger row ${day}`).toHaveLength(1));
  return dayRow(day);
}

/**
 * What `row` shows for the receivable of `platform`, given the other platforms of the same row:
 * the cell under a column titled with this platform (and none of the others), or else, inside
 * the row, the largest part around this platform's label that holds no other platform's label.
 */
export function receivableText(
  row: HTMLElement,
  platform: string,
  others: readonly string[],
): string {
  const own = platformPattern(platform);
  const foreign = others.map((one) => platformPattern(one));
  const titles = columnTitles(row);
  const columns = titles.flatMap((title, index) =>
    own.test(title) && !foreign.some((pattern) => pattern.test(title)) ? [index] : [],
  );
  expect(columns.length, `at most one column titled ${platform}`).toBeLessThanOrEqual(1);
  if (columns.length === 1) {
    const cell = row.children[columns[0]!];
    expect(cell, `the ${platform} cell`).toBeDefined();
    return textOf(cell!);
  }
  const labels = Array.from(row.querySelectorAll<HTMLElement>('*')).filter(
    (node) =>
      own.test(textOf(node)) && !Array.from(node.children).some((child) => own.test(textOf(child))),
  );
  expect(labels.length, `a label of ${platform} in the row`).toBeGreaterThan(0);
  return labels
    .map((label) => {
      let part: HTMLElement = label;
      let parent = part.parentElement;
      while (parent !== null && parent !== row) {
        const text = textOf(parent);
        if (foreign.some((pattern) => pattern.test(text))) break;
        part = parent;
        parent = part.parentElement;
      }
      return textOf(part);
    })
    .join(' | ');
}

/** Text of `row` plus the accessible names and titles inside it (an icon's tooltip label). */
export function rowHint(row: HTMLElement): string {
  const labelled = Array.from(row.querySelectorAll<HTMLElement>('[aria-label], [title]')).map(
    (node) => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`,
  );
  return [textOf(row), row.getAttribute('aria-label') ?? '', ...labelled].join(' ');
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

// ---- dialogs -------------------------------------------------------------------------------

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
/** Title of a dialog (aria-label, aria-labelledby looked up inside first, antd titles). */
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
/** The start / end input of the date range. */
export function dateField(which: 'from' | 'to'): HTMLInputElement | HTMLTextAreaElement {
  return textbox(main(), which === 'from' ? LABEL.dateFrom : LABEL.dateTo);
}
/** Types a day (YYYY-MM-DD) into a plain input or an antd date (range) picker input. */
export async function fillDay(input: HTMLElement, value: string): Promise<void> {
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
/** Fills both ends of the date range. */
export async function fillRange(from: string, to: string): Promise<void> {
  await fillDay(dateField('from'), from);
  await fillDay(dateField('to'), to);
  await settle();
}

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
