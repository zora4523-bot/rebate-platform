import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, vi, type Mock } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, mainElement } from '../admin-platform-icons/helpers.ts';
import {
  BASE_URL,
  CLAIMS,
  INVITE,
  LISTS,
  LOOKUP,
  ORDERS,
  PARENT,
  QUIET,
  SUPER,
  UID,
  USERS,
  WITHDRAWALS,
  createServer,
  uidClaims,
  uidOrders,
  uidWithdrawals,
  type RequestLog,
  type Server,
} from './fixtures.ts';

export { button, click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;

export type TabName = '订单' | '找回' | '提现';
export const TAB_NAMES: readonly TabName[] = ['订单', '找回', '提现'];
/** The list each tab reads. */
export const LIST_OF: Readonly<Record<TabName, string>> = {
  订单: ORDERS,
  找回: CLAIMS,
  提现: WITHDRAWALS,
};
/** The tab titles the page may have (F1-07ja whitelist; no counts in a title). */
export const ALLOWED_TABS = ['概览', '订单', '找回', '提现'];

/** A new no-permission notice. */
export const NO_PERMISSION = /无权限|没有[^。；，\n]{0,20}权限|权限不足/;
export const LOADING = /加载/;
export const FAILED = /失败|出错|异常/;
export const EMPTY = /暂无|没有[^。；，\n]{0,20}(?:记录|订单|找回|提现|数据)|无数据|还没有/;
/** Users a list request may name (each case opens only these). */
const KNOWN_USERS = [UID, PARENT, QUIET];
const USER_DETAIL =
  /^\/admin\/v1\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Session {
  readonly server: Server;
  readonly snapshot: PermissionSnapshot;
  readonly directFetch: Mock<typeof globalThis.fetch>;
  /** Lists whose tab this case opened (only those may be read). */
  readonly opened: Set<string>;
  /** Log index from which the case left the user detail through a row (another page's reads). */
  leftAt: number | undefined;
}
let session: Session | undefined;

function current(): Session {
  expect(session, 'a mounted console').toBeDefined();
  return session!;
}

/**
 * Mounts the real admin app (createAdminShell, memory router, default /users route) for the
 * account `snapshot`, with the REST data provider over the fake server. A direct global fetch
 * fails the case.
 */
export async function mount(snapshot = SUPER, server = createServer(snapshot)): Promise<Server> {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  session = { server, snapshot, directFetch, opened: new Set(), leftAt: undefined };
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
        initialRoute: { menuId: 'users' },
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  return server;
}

function allowed(state: Session, request: RequestLog, index: number): boolean {
  if (request.method !== 'GET') return false;
  // After a row opened another page (order / withdrawal detail), that page reads on its own.
  if (state.leftAt !== undefined && index >= state.leftAt) return true;
  if (request.path === USERS || request.path === LOOKUP || USER_DETAIL.test(request.path))
    return true;
  if ((LISTS as readonly string[]).includes(request.path))
    return state.opened.has(request.path) && KNOWN_USERS.includes(request.query['user_id'] ?? '');
  return false;
}

/**
 * afterEach of every case: only the user list / lookup / detail GETs and the list GETs of the
 * tabs the case opened (with a user_id) were sent; no write, no direct fetch. Then unmounts.
 */
export function finish(): void {
  const state = session;
  session = undefined;
  try {
    if (state !== undefined) {
      expect(state.directFetch, 'no direct fetch').not.toHaveBeenCalled();
      const outside = state.server.log
        .filter((request, index) => !allowed(state, request, index))
        .map(
          (request) =>
            `${request.method} ${request.path}?${new URLSearchParams(request.query).toString()}`,
        );
      expect(outside, 'requests outside the whitelist').toEqual([]);
    }
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
}

/** A first list read: page 1, sent as page=1 or left out (the contract's default is 1). */
export function expectFirstPage(read: RequestLog): void {
  expect([undefined, '1'], `page of ${read.path}`).toContain(read.query['page']);
}

export async function settled(): Promise<void> {
  const { server } = current();
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}

/** Waits until `uid`'s detail shows (its invite code). */
export async function detailLoaded(uid = UID): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain(INVITE[uid]));
}

/**
 * Opens `uid`'s detail the way the account can: 【详情】 of its list row with user.list, else the
 * UID lookup (user.lookup only).
 */
export async function openUser(uid = UID): Promise<void> {
  const { snapshot } = current();
  if (snapshot.isSuper || snapshot.permissions.includes('user.list')) {
    await waitFor(() =>
      expect(within(mainElement()).queryAllByText(uid, { exact: true }).length).toBeGreaterThan(0),
    );
    const row = within(mainElement()).queryAllByText(uid, { exact: true })[0]!.closest('tr');
    expect(row, `list row of ${uid}`).not.toBeNull();
    await click(button(row!, /^详情(?:\s|$)/));
  } else {
    const boxes = within(mainElement())
      .queryAllByRole('textbox')
      .filter((node) => node instanceof HTMLInputElement);
    expect(boxes, 'one UID / phone lookup box').toHaveLength(1);
    await act(async () => {
      fireEvent.change(boxes[0]!, { target: { value: uid } });
    });
    await click(button(mainElement(), /^(查找|查询|搜索)$/));
  }
  await detailLoaded(uid);
}

export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Text without any whitespace (a date and its time may sit on two lines). */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

/** Number of matches of `pattern` in the main area's text (to see what an action added). */
export function occurrences(pattern: RegExp): number {
  return (mainElement().textContent ?? '').match(new RegExp(pattern.source, 'g'))?.length ?? 0;
}

/** Tabs of the main area (with `hidden`, also those not shown). */
export function tabs(hidden = false): HTMLElement[] {
  return within(mainElement()).queryAllByRole('tab', { hidden });
}
export function tabNames(hidden = false): string[] {
  return tabs(hidden).map((tab) => clean(tab.textContent));
}
export function findTab(name: string): HTMLElement | undefined {
  return tabs().find((tab) => clean(tab.textContent) === name);
}

/** Waits for the detail's tab row: 「概览」 first. */
export async function tabRow(): Promise<void> {
  await waitFor(() => expect(tabNames()[0], 'first tab of the user detail').toBe('概览'));
}

/** Clicks the tab `name` (it must be there); its list may be read from now on. */
export async function openTab(name: TabName): Promise<void> {
  const tab = findTab(name);
  expect(tab, `tab 「${name}」`).toBeDefined();
  current().opened.add(LIST_OF[name]);
  await click(tab!);
}

export async function openOverview(): Promise<void> {
  const tab = findTab('概览');
  expect(tab, 'tab 「概览」').toBeDefined();
  await click(tab!);
}

/**
 * The tab `name` is not for this account: either it is not there, or opening it says there is
 * no permission. Either way its list is never read.
 */
export async function expectTabUnavailable(name: TabName): Promise<void> {
  const { server } = current();
  const tab = findTab(name);
  if (tab !== undefined) {
    const before = occurrences(NO_PERMISSION);
    await click(tab);
    await waitFor(() =>
      expect(occurrences(NO_PERMISSION), `「${name}」 says there is no permission`).toBeGreaterThan(
        before,
      ),
    );
    await settled();
  }
  expect(server.requests('GET', LIST_OF[name]), `no ${LIST_OF[name]} request`).toEqual([]);
}

/** The first row UID's list shows in the tab `name` (sub-order no., claim_id, out_biz_no). */
export function firstShown(name: TabName): string {
  if (name === '订单') return uidOrders()[0]!.sub_order_id;
  if (name === '找回') return uidClaims()[0]!.claim_id;
  return uidWithdrawals()[0]!.out_biz_no;
}

/** Table rows of the main area that show `text`. */
export function rowsWith(text: string): HTMLElement[] {
  return Array.from(mainElement().querySelectorAll<HTMLElement>('tr')).filter((row) =>
    (row.textContent ?? '').includes(text),
  );
}
export function rowWith(text: string): HTMLElement {
  const found = rowsWith(text);
  expect(found, `one row showing ${text}`).toHaveLength(1);
  return found[0]!;
}
export async function rowShown(text: string): Promise<void> {
  await waitFor(() => expect(rowsWith(text), `one row showing ${text}`).toHaveLength(1));
}

/** The cell of `row` under the one column whose title passes `title`. */
export function cellUnder(row: HTMLElement, title: (text: string) => boolean, what: string) {
  const table = row.closest('.ant-table') ?? row.closest('table');
  expect(table, `table of the row (${what})`).not.toBeNull();
  const header = table!.querySelector('thead tr');
  expect(header, `header row (${what})`).not.toBeNull();
  const titles = Array.from(header!.children, (cell) => clean(cell.textContent));
  const columns = titles.flatMap((text, index) => (title(text) ? [index] : []));
  expect(columns, `one ${what} column among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = row.children[columns[0]!];
  expect(cell, `${what} cell`).toBeDefined();
  return cell as HTMLElement;
}

/** Opens a list row's detail: its 【详情】 / 【查看】, else its number as a link or button. */
export async function openRow(row: HTMLElement, number: string): Promise<void> {
  const controls = (name: (text: string) => boolean): HTMLElement[] => [
    ...within(row).queryAllByRole('button', { name }),
    ...within(row).queryAllByRole('link', { name }),
  ];
  const named = controls((text) => /详情|查看/.test(text));
  const found = named.length > 0 ? named : controls((text) => clean(text) === number);
  expect(found.length, `a control in the row of ${number} opens it`).toBeGreaterThan(0);
  const state = current();
  state.leftAt = state.server.log.length;
  await click(found[0]!);
}

/** The next-page control of the (one) page-number pagination in the main area. */
export function nextPageControl(): HTMLElement {
  const next = mainElement().querySelector<HTMLElement>(
    '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
  );
  expect(next, 'page-number pagination next control').not.toBeNull();
  return next!;
}

/** Clicks the visible link of `uid` in the overview (上级 and the like). */
export async function openLinkedUser(uid: string): Promise<void> {
  const links = within(mainElement())
    .queryAllByText(uid, { exact: true })
    .map((node) => node.closest<HTMLElement>('button, a'))
    .filter((node): node is HTMLElement => node !== null);
  expect(links.length, `a link to ${uid} in the overview`).toBeGreaterThan(0);
  await click(links[0]!);
}
