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
  PHONE,
  VERIFY,
  createServer,
  smsPath,
  snapshot as snapshotOf,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `messages`): no
// import of the page module, so a missing page is an assertion failure, not an import error.
// antd's first Table / Tabs / Drawer / Modal render of a file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → dialog → step-up → write → list). */
export const FLOW_TIMEOUT = 60_000;

/** Title of the shared step-up dialog (components/step-up, totp). */
export const STEP_UP = /二次验证\s*·\s*动态码/;
/** The no-permission notice (10403). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** The 20902 notice: the code changed meanwhile, refresh. */
export const CONFLICT = /已变化|已变更|已被.*修改|他人修改|冲突|刷新后重试|已重新读取|已刷新/;
/** The test send was not accepted (AdmNotifySmsTestSendFailed). */
export const NOT_ACCEPTED = /未受理|未被受理|没有受理|不受理/;
/** …and the registration in use stays in force. */
export const KEPT = /继续生效|仍(?:然)?生效|仍在使用/;
/** Mentions the registration in use (not shown for a first registration, D10-339 ④). */
export const ORIGINAL = /原配置|当前生效/;
/** No verify phone registered (AdmNotifySmsTestSendNoPhone; 「请先登记验证手机号」). */
export const NO_PHONE = /登记验证手机号|验证手机号.*未登记|未登记.*验证手机号|没有.*验证手机号/;
/** A write that did not go through (switch failures). */
export const FAILED = /失败|未能|没有成功|不能|无法|错误|出错|不可/;
/** The test send was accepted (AdmNotifySmsTestSendOk; status side note 「测试已受理」). */
export const ACCEPTED = /已受理/;

// Status words of the 「短信」 tab (design §2: no new status words, D10-339 ①).
export const STATUS = {
  enabled: '已启用',
  pending: '待测试',
  failed: '测试失败',
  unregistered: '未登记',
  fallback: '部署配置兜底',
  accepted: '测试已受理',
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

/** Mounts the real admin shell on 运营 / 消息模板 over the fake server. */
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
  const snapshot = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'messages' },
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '运营' },
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
export function bodyText(): string {
  return squash(document.body.textContent);
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
/** `word` as a whole token (codes and variants are [A-Za-z0-9_]). */
function token(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`);
}

/** Text of `scope` without what is typed into its fields (a textarea's value is its text). */
export function shownText(scope: HTMLElement): string {
  const copy = scope.cloneNode(true) as HTMLElement;
  for (const node of Array.from(copy.querySelectorAll('textarea, input, select'))) node.remove();
  return copy.textContent ?? '';
}
/** `scope` shows `word` as a whole token outside its fields. */
export function shows(scope: HTMLElement, word: string): boolean {
  return token(word).test(shownText(scope));
}

// ---- tabs ----------------------------------------------------------------------------------

function tabs(name: string): HTMLElement[] {
  return within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter((tab) => squash(tab.textContent) === name || tab.getAttribute('aria-label') === name);
}
/** The panel of tab `name` (aria-controls, else the one visible tab panel). */
export function panelOf(name: string): HTMLElement {
  const found = tabs(name);
  expect(found, `tab ${name}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  const visible = within(main()).queryAllByRole('tabpanel');
  expect(visible, 'one visible tab panel').toHaveLength(1);
  return visible[0]!;
}
export async function openTab(name: string): Promise<HTMLElement> {
  await waitFor(() => expect(tabs(name), `tab ${name}`).toHaveLength(1));
  await click(tabs(name)[0]!);
  return panelOf(name);
}
export const CHANNELS_TAB = '消息模板';
export const SMS_TAB = '短信';

/** Opens the 「消息模板」 tab and waits for the row of `code`. */
export async function openChannels(code = 'WD_FAILED'): Promise<HTMLElement> {
  await openTab(CHANNELS_TAB);
  await waitFor(() => expect(rowsOf(panelOf(CHANNELS_TAB), [code])).toHaveLength(1));
  return panelOf(CHANNELS_TAB);
}
/** Opens the 「短信」 tab and waits for the row of `code` · `variant`. */
export async function openSms(code = 'WD_FAILED', variant = 'default'): Promise<HTMLElement> {
  await openTab(SMS_TAB);
  await waitFor(() => expect(rowsOf(panelOf(SMS_TAB), [code, variant])).toHaveLength(1));
  return panelOf(SMS_TAB);
}

// ---- rows, cells, switches -----------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `scope` whose text holds every token of `words`. */
export function rowsOf(scope: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map(token);
  const matching = Array.from(scope.querySelectorAll<HTMLElement>(ROW)).filter((node) =>
    patterns.every((pattern) => pattern.test(node.textContent ?? '')),
  );
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** The one row of `code` in the 「消息模板」 tab. */
export function channelRow(code: string): HTMLElement {
  const found = rowsOf(panelOf(CHANNELS_TAB), [code]);
  expect(found, `one row for ${code}`).toHaveLength(1);
  return found[0]!;
}
/** The one row of `code` · `variant` in the 「短信」 tab. */
export function smsRow(code: string, variant = 'default'): HTMLElement {
  const found = rowsOf(panelOf(SMS_TAB), [code, variant]);
  expect(found, `one SMS row for ${code} · ${variant}`).toHaveLength(1);
  return found[0]!;
}
export function hasSmsRow(code: string): boolean {
  return rowsOf(panelOf(SMS_TAB), [code]).length > 0;
}

export const CHANNEL_TITLE = { inbox: '站内信', push: '推送', sms: '短信' } as const;

/** Column titles of the header row of `panel` (spaces removed). */
function columnTitles(panel: HTMLElement): string[] {
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  return Array.from(header!.children, (cell) => squash(cell.textContent));
}

/** The cell of `code` under the column titled 站内信 / 推送 / 短信. */
export function channelCell(code: string, channel: keyof typeof CHANNEL_TITLE): HTMLElement {
  const titles = columnTitles(panelOf(CHANNELS_TAB));
  const title = CHANNEL_TITLE[channel];
  let index = titles.indexOf(title);
  if (index < 0) index = titles.findIndex((text) => text.startsWith(title));
  expect(index, `column ${title}`).toBeGreaterThanOrEqual(0);
  const cell = channelRow(code).children[index];
  expect(cell, `${code} / ${title}`).toBeDefined();
  return cell as HTMLElement;
}

/** The cell of `code` · `variant` in the 「短信」 tab under the one column whose title matches. */
export function smsCell(code: string, variant: string, title: RegExp): HTMLElement {
  const titles = columnTitles(panelOf(SMS_TAB));
  const indexes = titles.flatMap((text, index) => (title.test(text) ? [index] : []));
  expect(indexes, `one column titled ${String(title)}`).toHaveLength(1);
  const cell = smsRow(code, variant).children[indexes[0]!];
  expect(cell, `${code} · ${variant} / ${String(title)}`).toBeDefined();
  return cell as HTMLElement;
}
/** Text of the 状态 cell of `code` · `variant` (spaces removed). */
export function statusOf(code: string, variant = 'default'): string {
  return squash(smsCell(code, variant, /^状态$/).textContent);
}

/** Switches of `scope` named 「推送 CODE」 / 「短信 CODE」 (hidden ones included). */
export function switchesOf(scope: HTMLElement, channel?: 'push' | 'sms', code?: string) {
  const all = within(scope).queryAllByRole('switch', { hidden: true });
  if (channel === undefined || code === undefined) return all;
  const name = new RegExp(`^${CHANNEL_TITLE[channel]}\\s*${escape(code)}(?![A-Za-z0-9_])`);
  return all.filter((node) => {
    const label = (node.getAttribute('aria-label') ?? '').trim();
    const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const labelled = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    return name.test(label) || name.test(labelled.trim());
  });
}
/** The one switch 「推送 CODE」 / 「短信 CODE」 in the code's row. */
export function toggle(channel: 'push' | 'sms', code: string): HTMLElement {
  const found = switchesOf(channelRow(code), channel, code);
  expect(found, `one switch ${CHANNEL_TITLE[channel]} ${code}`).toHaveLength(1);
  return found[0]!;
}
export function isOn(channel: 'push' | 'sms', code: string): boolean {
  return toggle(channel, code).getAttribute('aria-checked') === 'true';
}
export function isDisabled(node: HTMLElement): boolean {
  return (
    node.hasAttribute('disabled') ||
    node.getAttribute('aria-disabled') === 'true' ||
    node.closest('[aria-disabled="true"], fieldset[disabled]') !== null
  );
}

// ---- buttons -------------------------------------------------------------------------------

/** Buttons and links of `scope` whose text or aria-label matches `name` (spaces ignored). */
export function actions(scope: HTMLElement, name: RegExp): HTMLElement[] {
  return Array.from(
    scope.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"]'),
  ).filter(
    (node) =>
      node.getAttribute('role') !== 'switch' &&
      (name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label')))),
  );
}
export function action(scope: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(scope, name);
  expect(found, `one action ${String(name)}`).toHaveLength(1);
  return found[0]!;
}
/** Usable (not disabled) actions of `scope` named `name`. */
export function usable(scope: HTMLElement, name: RegExp): HTMLElement[] {
  return actions(scope, name).filter((node) => !isDisabled(node));
}

// Row and dialog buttons of the design (§2).
export const EDIT = /^编辑/;
export const REGISTER = /^登记/;
export const TEST_SEND = /^测试发送/;
export const RETEST = /^重新测试/;
export const DISCARD = /^放弃新配置/;
export const ENABLE = /^启用新配置/;
export const LATER = /^稍后再启用/;
export const REVISE = /^修改配置/;
export const SEND = /^发送测试短信/;
export const SAVE = /^保存/;
/** Every write entry of the page (design §5: none without notify.channels). */
export const WRITE_ACTIONS = /^(?:编辑|登记|测试发送|重新测试|放弃新配置|启用新配置|保存)/;

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
export function stepUpDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => STEP_UP.test(titleOf(node)));
}
export function otherDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => !STEP_UP.test(titleOf(node)));
}
export function stepUpOpen(): boolean {
  return stepUpDialogs().length > 0;
}
/** The one open step-up dialog. */
export async function stepUpDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'step-up dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** The one open dialog or drawer that is not the step-up dialog. */
export async function otherDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(otherDialogs(), 'one dialog besides step-up').toHaveLength(1));
  return otherDialogs()[0]!;
}
/** Open dialogs (not step-up) that hold an action named `name`. */
export function dialogsWith(name: RegExp): HTMLElement[] {
  return otherDialogs().filter((node) => actions(node, name).length > 0);
}
/** The one open dialog (not step-up) that holds an action named `name`. */
export async function dialogWith(name: RegExp): Promise<HTMLElement> {
  await waitFor(() => expect(dialogsWith(name), `a dialog with ${String(name)}`).toHaveLength(1));
  return dialogsWith(name)[0]!;
}
export async function verify(modal: HTMLElement): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(within(modal).getByRole('button', { name: '验证并继续' }));
  await settle();
}
export async function cancelStepUp(modal: HTMLElement): Promise<void> {
  await click(within(modal).getByRole('button', { name: '取消' }));
  await settle();
}

/** The masked phone is shown in `scope` (as text, or in a field that cannot be edited). */
export function showsPhone(scope: HTMLElement, phone = PHONE): boolean {
  if (squash(scope.textContent).includes(phone)) return true;
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input'));
  return inputs.some((node) => node.value === phone && (node.readOnly || node.disabled));
}
/** Fields of `scope` holding `phone` that can still be edited (design: 发送到 is not editable). */
export function editablePhone(scope: HTMLElement, phone = PHONE): HTMLElement[] {
  const fields = Array.from(scope.querySelectorAll<HTMLInputElement>('input, textarea'));
  return fields.filter((node) => node.value === phone && !node.readOnly && !node.disabled);
}

/** Where a confirmation shows (portaled popovers and confirm dialogs). */
const CONFIRM_SCOPES =
  '.ant-popover, .ant-popconfirm, [role="tooltip"], [role="alertdialog"], [role="dialog"]';

/** Popconfirm / confirm buttons named `name` outside the page. */
function confirmButtons(name: RegExp): HTMLElement[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(CONFIRM_SCOPES));
  const scopes = nodes.filter((node) => visible(node) && !main().contains(node));
  const outside = scopes.filter((node) => !STEP_UP.test(titleOf(node)));
  // The selectors may match nested elements of one popover: each button once.
  return [...new Set(outside.flatMap((scope) => usable(scope, name)))];
}
export function confirmOpen(): boolean {
  return confirmButtons(/^(?:确定|确认|放弃)/).length > 0;
}
/** Answers the confirmation that 【放弃新配置】 opens (Popconfirm, design §6). */
export async function answerConfirm(accept: boolean): Promise<void> {
  const name = accept ? /^(?:确定|确认|放弃)/ : /^取消/;
  await waitFor(() => expect(confirmButtons(name), `confirm ${String(name)}`).toHaveLength(1));
  await click(confirmButtons(name)[0]!);
  await settle();
}

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification, antd Alert. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert';

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
/** Text the operator is told in: a notice, or a dialog / drawer other than step-up. */
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  const dialog = element.closest<HTMLElement>('[role="dialog"]');
  if (dialog !== null) return !STEP_UP.test(titleOf(dialog));
  return element.closest(NOTICES) !== null;
}
/**
 * Text that is new (or changed) since `before`, in notices and in dialogs / drawers other than
 * step-up; standing text that was on the page before the action does not count.
 */
export function freshText(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}

export function assertWrite(request: RequestLog, value: string): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(value);
}
export function assertVerified(server: Server, count: number): void {
  expect(server.requests('POST', VERIFY).map((r) => r.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: '123456' })),
  );
}
/** The query of a request with `variant` as the server reads it (default when absent). */
export function queryOf(request: RequestLog): Record<string, string> {
  return { ...request.query, variant: request.query['variant'] ?? 'default' };
}
/** Keys of a request body that `allowed` does not list. */
export function extraKeys(request: RequestLog, allowed: readonly string[]): string[] {
  const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

// ---- drawer fields -------------------------------------------------------------------------

/** Field labels of the drawer (Form.Item label or aria-label). */
export const LABEL = {
  sign: /^\s*(?:短信)?签名/,
  template: /模板\s*CODE|模板编号|模板代码|template_code/i,
  preview: /^\s*(?:预览(?:正文)?|正文)/,
} as const;

/** The text input (or textarea) labelled `label` in `scope`. */
export function textbox(scope: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = within(scope)
    .queryAllByLabelText(label)
    .filter(
      (node): node is HTMLInputElement | HTMLTextAreaElement =>
        (node instanceof HTMLInputElement &&
          !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
          node.getAttribute('role') !== 'combobox') ||
        node instanceof HTMLTextAreaElement,
    );
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}
const TYPED_FIELDS =
  'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), textarea';

/** Text inputs and textareas of `scope` that can be typed into. */
export function editableFields(scope: HTMLElement): HTMLElement[] {
  const fields = Array.from(scope.querySelectorAll<HTMLInputElement>(TYPED_FIELDS));
  return fields.filter((node) => !node.readOnly && !node.disabled && !isDisabled(node));
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
export async function expectFieldError(input: HTMLElement, including?: string): Promise<void> {
  await waitFor(() => {
    const text = fieldError(input);
    expect(text, 'an error next to the field').not.toBe('');
    if (including !== undefined) expect(text).toContain(including);
  });
}

/** Opens 【编辑】 (registered) or 【登记】 (unregistered) of an SMS row; returns its drawer. */
export async function openDrawer(code: string, variant = 'default'): Promise<HTMLElement> {
  await openSms(code, variant);
  const found = usable(smsRow(code, variant), /^(?:编辑|登记)/);
  expect(found, `one usable 编辑 / 登记 for ${code} · ${variant}`).toHaveLength(1);
  await click(found[0]!);
  return otherDialog();
}

/**
 * 【保存】 of a new signature or template CODE with a verify phone (design §2): the test-send
 * dialog first (no step-up, nothing written), then 【发送测试短信】 → step-up → one PUT.
 * Returns the test-send dialog and the page text from just before 【保存】.
 */
export async function saveWithTest(
  server: Server,
  drawer: HTMLElement,
  code: string,
): Promise<{ modal: HTMLElement; before: TextSnapshot }> {
  const puts = server.requests('PUT', smsPath(code)).length;
  const before = snapshotText();
  await click(action(drawer, SAVE));
  const modal = await dialogWith(SEND);
  expect(stepUpOpen(), 'no step-up before 【发送测试短信】').toBe(false);
  expect(server.requests('PUT')).toHaveLength(puts);
  await click(action(modal, SEND));
  const verification = await stepUpDialog();
  expect(server.requests('PUT')).toHaveLength(puts);
  await verify(verification);
  await waitFor(() => expect(server.requests('PUT', smsPath(code))).toHaveLength(puts + 1));
  await settled(server);
  return { modal, before };
}

/** 【保存】 that goes straight to the step-up (preview text only, or no verify phone), one PUT. */
export async function saveDirect(
  server: Server,
  drawer: HTMLElement,
  code: string,
): Promise<TextSnapshot> {
  const puts = server.requests('PUT', smsPath(code)).length;
  const before = snapshotText();
  await click(action(drawer, SAVE));
  const verification = await stepUpDialog();
  expect(dialogsWith(SEND), 'no test-send dialog').toEqual([]);
  expect(server.requests('PUT')).toHaveLength(puts);
  await verify(verification);
  await waitFor(() => expect(server.requests('PUT', smsPath(code))).toHaveLength(puts + 1));
  await settled(server);
  return before;
}

/**
 * 【保存】 whose answer is a field error: either the page stops it before any request (an error
 * next to `field`, no step-up, no PUT), or it goes through the test-send dialog and / or the
 * step-up and the server's 20001 answers. Returns whether a PUT was sent.
 */
export async function saveExpectingFieldError(
  server: Server,
  drawer: HTMLElement,
  field: HTMLElement,
): Promise<boolean> {
  const puts = server.requests('PUT').length;
  await click(action(drawer, SAVE));
  for (let step = 0; step < 3; step += 1) {
    await waitFor(() =>
      expect(
        dialogsWith(SEND).length > 0 || stepUpOpen() || fieldError(field) !== '',
        'a test-send dialog, a step-up or an error next to the field',
      ).toBe(true),
    );
    if (stepUpOpen()) {
      await verify(await stepUpDialog());
      await waitFor(() => expect(server.requests('PUT')).toHaveLength(puts + 1));
      await settled(server);
      return true;
    }
    const send = dialogsWith(SEND);
    if (send.length > 0) {
      await click(action(send[0]!, SEND));
      await settle();
      continue;
    }
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(puts);
    return false;
  }
  return expect.unreachable('【保存】 reached no outcome after three steps');
}
