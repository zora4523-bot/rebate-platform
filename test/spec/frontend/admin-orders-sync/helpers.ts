import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi, type Mock } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { BASE_URL, NUMBER, createServer, type RequestLog, type Server } from './fixtures.ts';

// The entries are reached only through the real shell (createAdminShell on /orders or
// /orders/<order_id>): no page module is imported, so a missing entry is an assertion failure.
// What the page must offer (accessible names, not styles):
// - list title row: a button or link named 【手动同步】 and one named 【同步记录】;
// - detail: a button named 【同步此单】 (the order number may follow in its accessible name);
// - the manual sync dialog: role dialog titled 「手动同步…」, a mode switch named 「按时间窗…」 /
//   「按订单号…」 (tab, radio, segmented item or button), a platform select (combobox or radio
//   group) named 「平台」, start and end time text fields labelled (or with a placeholder) 「开始…」 /
//   「结束…」 that take typed Beijing time 「YYYY-MM-DD HH:mm」 (or native datetime-local), an order
//   number text field (input or textarea) labelled 「订单号」 taking one number per line, an
//   optional order status filter of the window form labelled 「订单状态」 (a select whose options
//   show the value they send, or a text field), and a submit button 【提交同步】 (or 提交 / 确定 /
//   确认).
// - 【同步此单】 may send at once, ask a simple confirmation, or open the manual sync dialog with
//   the detail's platform and order number filled in; only the final POST body is asserted.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → dialog → write → notice). */
export const FLOW_TIMEOUT = 60_000;

export const VIEWER: PermissionSnapshot = { isSuper: false, permissions: ['order.view'] };
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
/** An account that cannot open the order pages. */
export const OUTSIDER: PermissionSnapshot = { isSuper: false, permissions: ['user.view'] };

// ---- notices -----------------------------------------------------------------------------------

/** 200 reused=false: submitted / queued. */
export const SUBMITTED = /已提交|已发起|已创建|已加入|排队/;
/** 200 reused=true: an equal sync is already queued or running. */
export const REUSED = /已有|相同|复用|已在(?:队列|排队|进行|执行|同步)/;
/** 30156: the site owner's authorization of the platform is paused. */
export const PAUSED = /授权.{0,12}暂停|暂停.{0,12}授权/;
/** 10403. */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** 429: try again later. */
export const RATE_LIMITED = /稍后|频繁|过快|太快/;
/** A failed request (network or server). */
export const FAILED = /失败|网络|出错|异常|未能|重试/;
/** The sync records list has no rows. */
export const EMPTY = /暂无|没有.{0,8}记录|无.{0,4}记录|为空/;

// ---- entries -----------------------------------------------------------------------------------

export const MANUAL_ENTRY = /^手动同步$/;
export const RECORDS_ENTRY = /^同步记录$/;
export const THIS_ORDER_ENTRY = /^同步此单/;
export const MODE = { window: /^按时间窗/, order_nos: /^按订单号/ } as const;
export const SUBMIT = /^(?:提交同步|提交|确定|确认|开始同步)$/;
const CONFIRM = /^(?:确定|确认|提交|同步|继续|确认同步|同步此单|提交同步|开始同步)$/;
export const PLATFORM_LABEL = /^平台$/;
export const START = /开始|起始/;
export const END = /结束|截止/;
export const ORDER_NOS = /订单号/;

// ---- mounting and the request whitelist --------------------------------------------------------

const sessions: AdminAuthProvider[] = [];
const mounted = new Set<Server>();
const directFetches: Mock<typeof globalThis.fetch>[] = [];

afterEach(() => {
  const servers = [...mounted];
  mounted.clear();
  // Read before the mocks are restored.
  const directCalls = directFetches.splice(0).map((direct) => direct.mock.calls.length);
  try {
    cleanup();
    for (const auth of sessions.splice(0)) auth.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  } finally {
    // Every case, its error and retry paths included: only the F1-07e order reads, the limits,
    // the sync records and POST order-syncs (never hold / unhold / reassign / imports / exports).
    for (const server of servers)
      expect(server.unexpected(), 'only the order reads and the order-syncs operations').toEqual(
        [],
      );
    expect(
      directCalls.filter((calls) => calls > 0),
      'no fetch around the data provider',
    ).toEqual([]);
  }
});

/** Mounts the real admin shell on `route` over `server`. */
export async function mount(
  server: Server = createServer(),
  route = '/orders',
  snapshot: PermissionSnapshot = VIEWER,
) {
  mounted.add(server);
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  directFetches.push(directFetch);
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', route);
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '客服小林' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
      }),
    );
  });
  await settle();
  return { server, directFetch };
}

/** Mounts the order list and waits for its first row and for every request to settle. */
export async function mountList(server: Server = createServer(), snapshot = VIEWER) {
  const result = await mount(server, '/orders', snapshot);
  await waitFor(() => expect(main().textContent).toContain(NUMBER));
  await settled(server);
  return result;
}

/** Mounts the order detail of `number` on `route` and waits until it is shown. */
export async function mountDetail(server: Server, route: string, number: string) {
  const result = await mount(server, route);
  await waitFor(() => expect(main().textContent).toContain(number));
  await settled(server);
  return result;
}

// ---- generic DOM helpers -----------------------------------------------------------------------

/** The shell's main landmark. */
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
/** Lets real time pass (for a retry that must not happen). */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
export async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
  });
}
/** Types `value` into a text input or textarea (focus, change, blur). */
export async function fill(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  });
}

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.style.display === 'none' || node.hidden)) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (
      node.classList.contains('ant-popover-hidden') ||
      node.classList.contains('ant-tabs-tabpane-hidden')
    )
      return false;
  }
  return true;
}
export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}
/** Visible buttons and links of `root` whose text or aria-label matches `name` (spaces ignored). */
export function actions(root: ParentNode, name: RegExp): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  ).filter(
    (node) =>
      visible(node) &&
      (name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label')))),
  );
}
/** Usable (not disabled) actions of `root` named `name`. */
export function usable(root: ParentNode, name: RegExp): HTMLElement[] {
  return actions(root, name).filter((node) => !isDisabled(node));
}
export function action(root: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(root, name);
  expect(found, `one action ${String(name)}`).toHaveLength(1);
  return found[0]!;
}

// ---- dialogs -----------------------------------------------------------------------------------

const TITLES = '.ant-modal-title, .ant-drawer-title, .ant-modal-confirm-title';

/** Title of a dialog (aria-labelledby looked up inside first, aria-label, antd titles). */
export function titleOf(node: HTMLElement): string {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
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
export function syncDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => /手动同步/.test(titleOf(node)));
}
/** The open manual sync dialog, opened from the title row's 【手动同步】 when none is open. */
export async function openSyncDialog(): Promise<HTMLElement> {
  if (syncDialogs().length === 0) {
    await waitFor(() =>
      expect(usable(main(), MANUAL_ENTRY).length, 'a usable 【手动同步】').toBeGreaterThan(0),
    );
    await click(usable(main(), MANUAL_ENTRY)[0]!);
    await settle();
  }
  await waitFor(() => expect(syncDialogs(), 'one manual sync dialog').toHaveLength(1));
  return syncDialogs()[0]!;
}
/** The open manual sync dialog (looked up again: it may have re-rendered). */
export function syncDialog(): HTMLElement {
  const found = syncDialogs();
  expect(found, 'one manual sync dialog').toHaveLength(1);
  return found[0]!;
}

function nameOf(node: HTMLElement): string {
  const label = node.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return squash(label);
  if (node instanceof HTMLInputElement) return squash(node.closest('label')?.textContent);
  return squash(node.textContent);
}
/** Chooses the sync mode (time window or order numbers) in the dialog. */
export async function chooseMode(dialog: HTMLElement, mode: keyof typeof MODE): Promise<void> {
  const name = MODE[mode];
  const matching = (selector: string) =>
    Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter(
      (node) => visible(node) && name.test(nameOf(node)),
    );
  const found = [
    ...matching('[role="tab"]'),
    ...matching('.ant-segmented-item, label, [role="radio"], input[type="radio"]'),
    ...matching('button, [role="button"]'),
  ];
  expect(found.length, `a mode switch ${String(name)} in the dialog`).toBeGreaterThan(0);
  await click(found[0]!);
  await settle();
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
  return scopes.flatMap((node) =>
    Array.from(node.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}
/**
 * Chooses the platform matching `option` in the dialog (antd Select or radio group named 平台);
 * returns the texts of every platform offered.
 */
export async function choosePlatform(dialog: HTMLElement, option: RegExp): Promise<string[]> {
  const combos = within(dialog).queryAllByRole('combobox', { name: PLATFORM_LABEL });
  if (combos.length > 0) {
    expect(combos, 'one platform select').toHaveLength(1);
    const combo = combos[0]!;
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
    let offered: string[] = [];
    let target: HTMLElement | undefined;
    await waitFor(() => {
      const nodes = optionNodes(combo);
      offered = nodes.map((node) => (node.textContent ?? '').trim());
      target = nodes.find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `platform ${String(option)}`).toBeDefined();
    });
    await click(target!);
    await settle();
    return offered;
  }
  const groups = within(dialog).queryAllByRole('radiogroup', { name: PLATFORM_LABEL });
  expect(groups, 'a platform select or radio group named 平台').toHaveLength(1);
  const radios = within(groups[0]!).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a platform radio ${String(option)}`).toHaveLength(1);
  await click(target[0]!);
  await settle();
  return radios.map(text);
}

// ---- fields ------------------------------------------------------------------------------------

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** Visible text inputs and textareas of `root` labelled (or with a placeholder) matching `label`. */
export function textFields(
  root: HTMLElement,
  label: RegExp,
): (HTMLInputElement | HTMLTextAreaElement)[] {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  return [...new Set([...labelled, ...placeholders])].filter(
    (node): node is HTMLInputElement | HTMLTextAreaElement => isTextField(node) && visible(node),
  );
}
/** The one visible text input (or textarea) labelled `label` in `root`. */
export function textbox(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(root, label);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}
/** Types a Beijing time `YYYY-MM-DD HH:mm` into a picker input (or a datetime-local input). */
export async function fillTime(input: HTMLElement, value: string): Promise<void> {
  const typed =
    input instanceof HTMLInputElement && input.type === 'datetime-local'
      ? value.replace(' ', 'T')
      : value;
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input);
  });
  await settle();
}
/** Fills the time window of the dialog (both Beijing `YYYY-MM-DD HH:mm`). */
export async function fillWindow(dialog: HTMLElement, from: string, to: string): Promise<void> {
  await fillTime(textbox(dialog, START), from);
  await fillTime(textbox(dialog, END), to);
}

/** The optional order status filter of the time window form (画板「订单状态」). */
export const STATUS_FILTER = /状态/;
/** The no-filter choice of a status select. */
const ANY_STATUS = /全部|不限|所有|任意/;

/** What the operator chose as the status filter: typed into a text field, or picked in a select. */
export type StatusChoice =
  | { readonly kind: 'typed'; readonly value: string }
  | { readonly kind: 'picked'; readonly shown: string };

/** The status filter control of the dialog (a select or a text field labelled 「…状态…」). */
export function statusControl(dialog: HTMLElement): HTMLElement {
  const combos = within(dialog).queryAllByRole('combobox', { name: STATUS_FILTER });
  const found = [...combos, ...textFields(dialog, STATUS_FILTER)];
  expect(found, 'one status filter in the window form').toHaveLength(1);
  return found[0]!;
}
function optionText(node: HTMLElement): string {
  return (node.textContent ?? '').trim();
}

/**
 * Sets the order status filter of the time window form: types `typed` into a text field, or picks
 * the first option of a select other than the no-filter one (全部 / 不限).
 */
export async function chooseStatusFilter(
  dialog: HTMLElement,
  typed: string,
): Promise<StatusChoice> {
  const control = statusControl(dialog);
  if (control.getAttribute('role') !== 'combobox') {
    await fill(control, typed);
    await settle();
    return { kind: 'typed', value: typed };
  }
  await act(async () => {
    fireEvent.mouseDown(control);
  });
  let target: HTMLElement | undefined;
  await waitFor(() => {
    target = optionNodes(control).find((node) => !ANY_STATUS.test(optionText(node)));
    expect(target, 'a status option other than 全部').toBeDefined();
  });
  const shown = optionText(target!);
  await click(target!);
  await settle();
  return { kind: 'picked', shown };
}

/** The body's status_filter is the chosen one (a picked option shows the value it sends). */
export function assertStatusFilter(choice: StatusChoice, sent: unknown): void {
  expect(typeof sent, 'status_filter is a string').toBe('string');
  const value = sent as string;
  expect(value.length).toBeGreaterThanOrEqual(1);
  expect(value.length).toBeLessThanOrEqual(64);
  if (choice.kind === 'typed') {
    expect(value).toBe(choice.value);
    return;
  }
  const shown = squash(choice.shown);
  expect(shown, 'the picked option shows the value sent').toContain(squash(value));
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

// ---- the dialog flows --------------------------------------------------------------------------

/** Presses the submit button of the dialog. */
export async function submit(dialog: HTMLElement): Promise<void> {
  await click(action(dialog, SUBMIT));
  await settle();
}
/**
 * Opens the dialog (or uses the open one) and fills the order number form; returns the dialog.
 * The submit itself is left to the case.
 */
export async function prepareOrderNos(
  server: Server,
  platform: RegExp,
  numbers: readonly string[],
): Promise<HTMLElement> {
  const dialog = await openSyncDialog();
  await settled(server);
  await chooseMode(dialog, 'order_nos');
  await choosePlatform(dialog, platform);
  await fill(textbox(dialog, ORDER_NOS), numbers.join('\n'));
  await settle();
  return dialog;
}
/** Same for the time window form (Beijing `YYYY-MM-DD HH:mm`). */
export async function prepareWindow(
  server: Server,
  platform: RegExp,
  from: string,
  to: string,
): Promise<HTMLElement> {
  const dialog = await openSyncDialog();
  await settled(server);
  await chooseMode(dialog, 'window');
  await choosePlatform(dialog, platform);
  await fillWindow(dialog, from, to);
  return dialog;
}

/**
 * Usable confirm / submit buttons of any open dialog or popconfirm: a simple confirmation, or the
 * manual sync dialog opened with the detail's order number filled in.
 */
export function confirmControls(): HTMLElement[] {
  const scopes = [
    ...openDialogs(),
    ...Array.from(document.querySelectorAll<HTMLElement>('.ant-popover, .ant-popconfirm')).filter(
      visible,
    ),
  ];
  return [...new Set(scopes.flatMap((scope) => usable(scope, CONFIRM)))];
}
/**
 * Presses the detail's 【同步此单】 and, when it does not send at once, the confirm or submit of
 * what it opened (a confirmation or a filled manual sync dialog); returns the page text right
 * before the press that sends the request. Only the final POST body is asserted.
 */
export async function pressSyncThisOrder(server: Server): Promise<TextSnapshot> {
  await waitFor(() =>
    expect(usable(main(), THIS_ORDER_ENTRY).length, 'a usable 【同步此单】').toBeGreaterThan(0),
  );
  const sent = server.posts().length;
  let before = snapshotText();
  await click(usable(main(), THIS_ORDER_ENTRY)[0]!);
  await settled(server);
  if (server.posts().length === sent) {
    await waitFor(() =>
      expect(
        confirmControls().length,
        'a POST or a confirmation after 【同步此单】',
      ).toBeGreaterThan(0),
    );
    before = snapshotText();
    await click(confirmControls()[0]!);
    await settle();
  }
  return before;
}

// ---- text that appeared after an action --------------------------------------------------------

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;
/** Notices: alerts, status lines, antd message / notification, antd Alert, field explanations. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain, .ant-result';

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
function shown(node: Text): boolean {
  const element = node.parentElement;
  return element !== null && element.closest('textarea') === null && visible(element);
}
/** Text the operator is told in: a notice, or a dialog. */
function inReply(node: Text): boolean {
  const element = node.parentElement!;
  return element.closest('[role="dialog"]') !== null || element.closest(NOTICES) !== null;
}
/** New (or changed) text since `before` in notices and dialogs; standing text does not count. */
export function freshText(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && shown(node) && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}
/** New (or changed) visible text anywhere on the page since `before`. */
export function freshAll(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && shown(node))
      .map((node) => node.data)
      .join(''),
  );
}

// ---- rows of the sync records ------------------------------------------------------------------

/** A record is one table row (AdmOrderSyncRecords is a table). */
const ROW = 'tr, [role="row"]';

/** The innermost visible rows of the page whose text holds `marker` (spaces ignored). */
export function rowsWith(marker: string): HTMLElement[] {
  const wanted = squash(marker);
  const matching = Array.from(document.body.querySelectorAll<HTMLElement>(ROW)).filter(
    (node) => visible(node) && squash(node.textContent).includes(wanted),
  );
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** Opens the sync records from the title row's 【同步记录】. */
export async function openRecords(): Promise<void> {
  await waitFor(() =>
    expect(usable(main(), RECORDS_ENTRY).length, 'a usable 【同步记录】').toBeGreaterThan(0),
  );
  await click(usable(main(), RECORDS_ENTRY)[0]!);
  await settle();
}

// ---- requests ----------------------------------------------------------------------------------

/** A sync write: the bearer value, no step-up value, no Idempotency-Key. */
export function assertPlainWrite(request: RequestLog): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.has('X-Step-Up-Token'), 'no step-up on a manual sync').toBe(false);
  expect(request.headers.has('Idempotency-Key'), 'no Idempotency-Key on a manual sync').toBe(false);
}
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** The time window form: exactly platform, from and to (ISO 8601 with offset) at these instants. */
export function assertWindowBody(
  request: RequestLog,
  platform: string,
  from: string,
  to: string,
): void {
  const body = request.body as Record<string, unknown> | undefined;
  expect(body, 'a JSON body').toBeDefined();
  expect(Object.keys(body!).sort()).toEqual(['from', 'platform', 'to']);
  expect(body!['platform']).toBe(platform);
  expect(body!['from']).toMatch(WITH_OFFSET);
  expect(body!['to']).toMatch(WITH_OFFSET);
  expect(Date.parse(body!['from'] as string)).toBe(Date.parse(from));
  expect(Date.parse(body!['to'] as string)).toBe(Date.parse(to));
}
