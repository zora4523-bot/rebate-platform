// F1-07jc jsdom kit. The user detail is reached only through the real admin shell (menu `users`,
// the list's 【详情 <UID>】); no page module is imported, so a missing entry is an assertion
// failure. Every server a test mounts is checked after the test: only the list and detail reads,
// the step-up and the writes the test declared may have gone out.
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
import {
  BASE_URL,
  DETAIL,
  INVITE_CODE,
  OTP,
  PLATFORM_LABEL,
  UID,
  type Action,
  type Platform,
  type RequestLog,
  type Server,
} from './bindings-fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (detail → dialog → step-up → write → refresh). */
export const FLOW_TIMEOUT = 90_000;

export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
const READ_POINTS = ['user.list', 'user.lookup'];
const TOTP = { tier: 'totp', operations: {} } as const;
/** union.binding_reset only (with the read points), as /me would give it. */
export const RESET_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: [...READ_POINTS, 'union.binding_reset'],
  stepUp: { 'union.binding_reset': TOTP },
};
/** union.binding_disable only (with the read points). */
export const DISABLE_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: [...READ_POINTS, 'union.binding_disable'],
  stepUp: { 'union.binding_disable': TOTP },
};
/** Every point the read-only detail uses, none of union.binding_* (frozen F1-07i / j口径). */
export const READ_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: [...READ_POINTS, 'pii.reveal_phone', 'user.level', 'user.inviter'],
};

const mounted: Server[] = [];
afterEach(() => {
  const servers = mounted.splice(0);
  cleanup();
  vi.unstubAllGlobals();
  for (const server of servers)
    expect(server.strays(), 'only the reads, the step-up and the allowed writes').toEqual([]);
});

// ---- mounting ------------------------------------------------------------------------------

function installMediaQuery(): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
}

/** Mounts the real shell on 用户查询 over `server`, opens 【详情 UID】 and waits for the detail. */
export async function openUser(server: Server, snapshot: PermissionSnapshot = SUPER) {
  installMediaQuery();
  mounted.push(server);
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'users' },
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '运营' },
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
  const open = await waitFor(() => {
    const found = within(main()).queryAllByRole('button', { name: `详情 ${UID}` });
    expect(found, `【详情 ${UID}】 on the list`).toHaveLength(1);
    return found[0]!;
  });
  await click(open);
  await waitFor(() => expect(main().textContent).toContain(INVITE_CODE));
  await waitFor(() => expect(server.detailReads().length).toBeGreaterThan(0));
  await settled(server);
  bindingsTable();
  return { server, directFetch };
}

/** Drops the current mount (its server stays checked after the test). */
export function unmountAll(): void {
  cleanup();
  vi.unstubAllGlobals();
}

// ---- timing --------------------------------------------------------------------------------

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

// ---- text ----------------------------------------------------------------------------------

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}
export function required<T>(value: T | null | undefined, message: string): T {
  expect(value, message).not.toBeNull();
  expect(value, message).toBeDefined();
  return value as T;
}

export function main(): HTMLElement {
  return required(
    document.querySelector<HTMLElement>('main'),
    'the shell renders its main landmark',
  );
}

// ---- the union binding table ---------------------------------------------------------------

/** The detail's union binding table (aria-label 联盟授权, frozen [AC-F1-07j-DETAIL#3]). */
export function bindingsTable(): HTMLElement {
  const tables = Array.from(main().querySelectorAll<HTMLElement>('table')).filter(
    (table) => table.getAttribute('aria-label') === '联盟授权',
  );
  expect(tables, 'one table named 联盟授权').toHaveLength(1);
  return tables[0]!;
}
/** Header cell texts of the binding table. */
export function columnTitles(): string[] {
  return Array.from(bindingsTable().querySelectorAll('thead th'), (cell) =>
    squash(cell.textContent),
  );
}
/** The body row of `platform` (the row naming the platform). */
export function platformRow(platform: Platform): HTMLElement {
  const label = PLATFORM_LABEL[platform];
  const rows = Array.from(bindingsTable().querySelectorAll<HTMLElement>('tbody tr')).filter((row) =>
    textOf(row).includes(label),
  );
  expect(rows, `one ${platform} row in the binding table`).toHaveLength(1);
  return rows[0]!;
}
/** Waits until the row of `platform` shows `status`. */
export async function rowShows(platform: Platform, status: RegExp): Promise<void> {
  await waitFor(() => expect(textOf(platformRow(platform)), `${platform} row`).toMatch(status));
}

// ---- entries -------------------------------------------------------------------------------

/** Accessible names start with these (frozen [AC-F1-07j-BROWSER#4]). */
export const ENTRY: Readonly<Record<Action, RegExp>> = {
  reset: /^重置授权/,
  disable: /^停用返利/,
  enable: /^恢复/,
};
/** Any write entry of the binding table. */
export const ANY_ENTRY = /^(?:重置授权|停用返利|恢复)/;

export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}
/** The name a control goes by: its aria-label, else its text (spaces removed). */
export function nameOf(node: HTMLElement): string {
  const label = node.getAttribute('aria-label');
  return squash(label !== null && label.trim() !== '' ? label : node.textContent);
}
/** Buttons and links of `root` whose name matches `name`. */
export function actions(root: HTMLElement, name: RegExp): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="link"]'),
  ).filter((node) => name.test(nameOf(node)));
}
/** Usable (not disabled) actions of `root` named `name`. */
export function usable(root: HTMLElement, name: RegExp): HTMLElement[] {
  return actions(root, name).filter((node) => !isDisabled(node));
}
/** Waits for exactly one usable `action` entry in the row of `platform`. */
export async function entry(platform: Platform, action: Action): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      usable(platformRow(platform), ENTRY[action]),
      `one usable ${action} for ${platform}`,
    ).toHaveLength(1),
  );
  return usable(platformRow(platform), ENTRY[action])[0]!;
}
/** The usable entries of each action in the row of `platform` (by action). */
export function entriesOf(platform: Platform): Action[] {
  const row = platformRow(platform);
  return (['reset', 'disable', 'enable'] as const).filter(
    (action) => usable(row, ENTRY[action]).length > 0,
  );
}
/**
 * The row's `action` entry as a button or link whose accessible name starts with the action and
 * names the platform (aria-label or visible text; 规格 §6 「行操作名带平台」). Use with no dialog open.
 */
export function namedEntries(platform: Platform, action: Action): HTMLElement[] {
  const prefix = ENTRY[action];
  const label = PLATFORM_LABEL[platform];
  const named = (accessible: string) =>
    prefix.test(squash(accessible)) && accessible.includes(label);
  const row = platformRow(platform);
  return [
    ...within(row).queryAllByRole('button', { name: named }),
    ...within(row).queryAllByRole('link', { name: named }),
  ];
}
/** Presses every write-named control of the table that is disabled (it must do nothing). */
export async function pressDisabled(): Promise<void> {
  for (const node of actions(bindingsTable(), ANY_ENTRY).filter(isDisabled)) {
    await click(node);
    await settle();
  }
}

// ---- dialogs -------------------------------------------------------------------------------

/** The title of the step-up dialog (apps/admin StepUpModal, totp tier). */
export const STEP_UP_TITLE = /二次验证|动态码/;
const VERIFY_BUTTON = /^验证并继续$/;
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (node.classList.contains('ant-popover-hidden')) return false;
  }
  return true;
}
/** Open dialogs and pop-confirms (outermost layer of each). */
export function openLayers(): HTMLElement[] {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], .ant-popconfirm',
    ),
  ).filter(visible);
  return found.filter((node) => !found.some((other) => other !== node && other.contains(node)));
}
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
function isStepUp(node: HTMLElement): boolean {
  return STEP_UP_TITLE.test(titleOf(node));
}
export function stepUpDialogs(): HTMLElement[] {
  return openLayers().filter(isStepUp);
}
/** Open layers other than the step-up dialog, outside the main area (confirmation dialogs). */
export function confirmations(): HTMLElement[] {
  return openLayers().filter((node) => !isStepUp(node) && node.closest('main') === null);
}
/** Waits for the one confirmation dialog an entry opened. */
export async function confirmation(): Promise<HTMLElement> {
  await waitFor(() => expect(confirmations(), 'one confirmation dialog').toHaveLength(1));
  return confirmations()[0]!;
}
/** Presses `node` and waits for its confirmation dialog (no step-up before it). */
export async function open(node: HTMLElement): Promise<HTMLElement> {
  await click(node);
  const layer = await confirmation();
  expect(stepUpDialogs(), 'the confirmation comes before the step-up').toEqual([]);
  return layer;
}
/** The submit button of a confirmation dialog: its one button that does not dismiss it. */
export function submitOf(layer: HTMLElement): HTMLElement {
  const buttons = Array.from(layer.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (node) =>
      node.closest('.ant-modal-close, .ant-select, .ant-radio-group, label') === null &&
      squash(node.textContent) !== '' &&
      !DISMISS.test(squash(node.textContent)) &&
      !DISMISS.test(squash(node.getAttribute('aria-label'))),
  );
  expect(
    buttons.map((node) => squash(node.textContent)),
    'one submit button in the dialog',
  ).toHaveLength(1);
  return buttons[0]!;
}
/** Closes every confirmation dialog still open (its 【取消】 / 【关闭】 / 【知道了】 or ×). */
export async function closeConfirmations(): Promise<void> {
  for (const layer of confirmations()) {
    const buttons = Array.from(
      layer.querySelectorAll<HTMLElement>('button, [role="button"]'),
    ).filter(
      (node) =>
        !isDisabled(node) &&
        (node.closest('.ant-modal-close') !== null ||
          /^(?:取消|关闭|知道了|我知道了|返回|完成|Close|Cancel)$/i.test(
            squash(node.textContent) || squash(node.getAttribute('aria-label')),
          )),
    );
    expect(buttons.length, 'a way to close the dialog').toBeGreaterThan(0);
    await click(buttons[0]!);
  }
  await waitFor(() => expect(confirmations(), 'no confirmation dialog left').toEqual([]));
}
/** Waits for the step-up dialog. */
export async function stepUp(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'the step-up dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** Types the code into the step-up dialog and presses 【验证并继续】; waits for the verify. */
export async function verify(server: Server, twice = false): Promise<void> {
  const modal = await stepUp();
  const verifies = server.verifies().length;
  const inputs = within(modal)
    .queryAllByLabelText('动态码', { exact: true })
    .filter((node) => node instanceof HTMLInputElement);
  expect(inputs, 'the code input of the step-up dialog').toHaveLength(1);
  await act(async () => {
    fireEvent.change(inputs[0]!, { target: { value: OTP } });
  });
  const submit = usable(modal, VERIFY_BUTTON);
  expect(submit, '【验证并继续】').toHaveLength(1);
  await act(async () => {
    fireEvent.click(submit[0]!);
    if (twice) fireEvent.click(submit[0]!);
  });
  await waitFor(() => expect(server.verifies().length).toBe(verifies + 1));
}
/** Closes the step-up dialog with its 【取消】. */
export async function dismissStepUp(): Promise<void> {
  const modal = await stepUp();
  const cancel = usable(modal, /^取消$/);
  expect(cancel, '【取消】 of the step-up dialog').toHaveLength(1);
  await click(cancel[0]!);
  await waitFor(() => expect(stepUpDialogs()).toEqual([]));
}

// ---- the reason field ----------------------------------------------------------------------

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** The one text input labelled (or with a placeholder) 原因 in `layer`. */
export function reasonField(layer: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const labelled = within(layer).queryAllByLabelText(/原因/);
  const placeholders = within(layer).queryAllByPlaceholderText(/原因/);
  const found = [...new Set([...labelled, ...placeholders])].filter(isTextField);
  expect(found, 'one reason input in the dialog').toHaveLength(1);
  return found[0]!;
}
export async function fill(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

export interface Performed {
  /** The write request. */
  readonly write: RequestLog;
  /** The page's text just before the confirmation was submitted. */
  readonly prior: Before;
}
/**
 * Opens `action` of `platform`, types `reason`, submits (twice when `twice`), checks that nothing
 * was written before the step-up, verifies and waits for the write and its answer.
 */
export async function perform(
  server: Server,
  platform: Platform,
  action: Action,
  reason: string,
  twice = false,
): Promise<Performed> {
  const layer = await open(await entry(platform, action));
  await fill(reasonField(layer), reason);
  const writes = server.writes().length;
  const submit = submitOf(layer);
  const prior = before();
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
  await stepUp();
  expect(server.writes().length, `no ${platform} ${action} before the step-up`).toBe(writes);
  await verify(server, twice);
  await waitFor(() => expect(server.writes().length).toBe(writes + 1));
  await settled(server);
  return { write: server.writes().at(-1)!, prior };
}

// ---- text that appeared after an action ----------------------------------------------------

const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-result, .ant-form-item-explain';

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
export interface Before {
  readonly nodes: ReadonlyMap<Text, string>;
}
/** Every text node on the page with its text, taken before an action. */
export function before(): Before {
  return { nodes: new Map(textNodes().map((node): [Text, string] => [node, node.data])) };
}
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"], [role="alertdialog"], .ant-popconfirm') !== null)
    return true;
  return element.closest(NOTICES) !== null;
}
/** Text new (or changed) since `prior`, in notices and in dialogs (a table cell does not count). */
export function freshText(prior: Before): string {
  return squash(
    textNodes()
      .filter((node) => prior.nodes.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}
/** Text new (or changed) since `prior` inside `root`. */
export function freshIn(prior: Before, root: HTMLElement): string {
  return squash(
    textNodes()
      .filter(
        (node) =>
          prior.nodes.get(node) !== node.data &&
          root.contains(node) &&
          node.parentElement !== null &&
          node.parentElement.closest('textarea') === null &&
          visible(node.parentElement),
      )
      .map((node) => node.data)
      .join(''),
  );
}
/** A new notice or dialog text says `pattern`. */
export async function announce(prior: Before, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(freshText(prior), `a notice ${String(pattern)}`).toMatch(pattern));
}

/** What the operator is told after an operation (only text new since the operation counts). */
export const HINT = {
  reset: /(?:重置|解除).{0,12}(?:成功|完成)|成功(?:重置|解除)|已(?:重置|解除)授权/,
  disable: /停用.{0,12}(?:成功|完成)|成功停用|已停用返利/,
  enable: /恢复.{0,12}(?:成功|完成)|成功恢复|已恢复/,
  changed: /状态已变化|已变化|已变更|已被.{0,10}(?:修改|处理|操作|更新)|请刷新|已刷新/,
  notAllowed:
    /不允许|(?:不能|无法|不可|不支持).{0,10}(?:此|这项|该|这个)?操作|状态.{0,10}(?:不能|无法|不可)/,
  platform:
    /(?:平台|淘宝|拼多多).{0,16}(?:不支持|不能|无法|不可|不适用|没有|无)|(?:不支持|不能|无法|不可).{0,12}(?:平台|淘宝|拼多多)/,
  user: /用户.{0,10}(?:不存在|找不到|未找到)|(?:不存在|找不到|未找到).{0,8}用户/,
  forbidden: /权限/,
  failed: /网络|失败|异常|稍后/,
  /** Says the reason is required or too long (a bare 「4 / 200」 counter or 「参数错误」 does not). */
  reason:
    /原因|必填|不能为空|不可为空|不得为空|请填写|请输入|\d+\s*个?字|不超过|不能超过|超过|超出|最多|至多|过长|太长/,
} as const;

/** The reason rule stated in a dialog whose submit is held disabled (a counter alone does not). */
export const REASON_RULE =
  /必填|不能为空|不可为空|不得为空|请填写|\d+\s*个?字|不超过|不能超过|最多|至多/;

// ---- the reason hint (character counters do not count) -------------------------------------

/** Character counters of an input (antd showCount); their 「n / 200」 is never a hint. */
const COUNTERS = '.ant-input-data-count, .ant-input-show-count-suffix';
/** Hint areas of a form field inside a dialog. */
const FIELD_NOTICES = '[role="alert"], .ant-form-item-explain, .ant-form-item-extra';

/** Text with spaces and any 「n / m」 counter removed. */
function withoutCounts(text: string): string {
  return squash(text).replace(/\d+[/／]\d+/g, '');
}
/** A visible text node outside the input itself, its label and its counter. */
function hintNode(node: Text): boolean {
  const element = node.parentElement;
  return (
    element !== null &&
    visible(element) &&
    element.closest(`textarea, label, .ant-form-item-label, ${COUNTERS}`) === null
  );
}
/** The visible text of `root` without counters (labels and static help included). */
export function ruleText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element === null || !visible(element)) continue;
    if (element.closest(`textarea, ${COUNTERS}`) !== null) continue;
    parts.push((node as Text).data);
  }
  return withoutCounts(parts.join(''));
}
/** Areas beside the reason input of `layer`: its form item, its described-by / error targets, alerts. */
function besideReason(layer: HTMLElement): HTMLElement[] {
  const field = reasonField(layer);
  const areas = Array.from(layer.querySelectorAll<HTMLElement>(FIELD_NOTICES));
  const item = field.closest<HTMLElement>('.ant-form-item');
  if (item !== null) areas.push(item);
  for (const name of ['aria-describedby', 'aria-errormessage'])
    for (const id of (field.getAttribute(name) ?? '').split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(id);
      if (target !== null) areas.push(target);
    }
  return areas;
}
/**
 * Hint text new since `prior` beside the reason input of `layer` (counters and labels left out).
 * With `orNotice` (nothing was sent) a new alert, message or notification anywhere counts too.
 */
export function reasonHint(prior: Before, layer: HTMLElement, orNotice: boolean): string {
  const areas = besideReason(layer);
  if (orNotice) areas.push(...Array.from(document.querySelectorAll<HTMLElement>(NOTICES)));
  return withoutCounts(
    textNodes()
      .filter(
        (node) =>
          prior.nodes.get(node) !== node.data &&
          hintNode(node) &&
          areas.some((area) => area.contains(node)),
      )
      .map((node) => node.data)
      .join(''),
  );
}

// ---- requests ------------------------------------------------------------------------------

/** Waits for a read of the detail sent after `request`. */
export async function readAgain(server: Server, request: RequestLog): Promise<void> {
  const sent = server.log.indexOf(request);
  expect(sent, 'the request is in the log').toBeGreaterThanOrEqual(0);
  await waitFor(() =>
    expect(
      server.log.slice(sent + 1).filter((one) => one.method === 'GET' && one.path === DETAIL),
      'the detail is read again',
    ).not.toEqual([]),
  );
  await settled(server);
}
/** The step-up grant a request carried. */
export function passOf(request: { readonly headers: Headers }): string | null {
  return request.headers.get('X-Step-Up-Token');
}
