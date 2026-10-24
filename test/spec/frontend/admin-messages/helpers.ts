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
import { BASE_URL, FULL, VERIFY, createServer, type RequestLog, type Server } from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `messages`): no
// import of the page module, so a missing page is an assertion failure, not an import error.
// antd's first Table / Tabs / Drawer / Modal render of a file is slow in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → dialog → step-up → write → list). */
export const FLOW_TIMEOUT = 60_000;

/** Title of the shared step-up dialog (components/step-up, totp). */
export const STEP_UP = /二次验证\s*·\s*动态码/;
/** The no-permission notice (10403 / no notify.channels). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** The 20902 notice: the code changed meanwhile, refresh. */
export const CONFLICT = /已变化|已变更|已被.*修改|他人修改|冲突|刷新后重试|已重新读取|已刷新/;
/** The test send was not accepted (AdmNotifySmsTestSendFailed). */
export const NOT_ACCEPTED = /未受理|未被受理|没有受理|不受理|发送失败|测试发送.*失败/;
/** …and nothing was saved: the old registration stays in force. */
export const KEPT = /继续生效|仍(?:然)?生效|仍在使用|未保存|没有保存/;
/** No verification phone registered (AdmNotifySmsTestSendNoPhone). */
export const NO_PHONE = /登记验证手机号|验证手机号.*未登记|未登记.*验证手机号|没有.*验证手机号/;
/** A write that did not go through (switch failures). */
export const FAILED = /失败|未能|没有成功|不能|无法|错误|出错|不可/;
/** The test send was accepted (AdmNotifySmsTestSendOk). */
export const ACCEPTED = /已受理|受理成功/;
/** Saved without a test send (test_send_phone_masked = null). */
export const SAVED = /已保存|保存成功/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export interface MountOptions {
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
  const snapshot = options.snapshot ?? FULL;
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
async function openTab(name: string): Promise<HTMLElement> {
  await waitFor(() => expect(tabs(name), `tab ${name}`).toHaveLength(1));
  await click(tabs(name)[0]!);
  return panelOf(name);
}
export const CHANNELS_TAB = '消息模板';
export const SMS_TAB = '短信';

/** Opens the 「消息模板」 tab and waits for the row of `code`. */
export async function openChannels(code = 'WD_SUCCESS'): Promise<HTMLElement> {
  await openTab(CHANNELS_TAB);
  await waitFor(() => expect(rowsOf(panelOf(CHANNELS_TAB), [code])).toHaveLength(1));
  return panelOf(CHANNELS_TAB);
}
/** Opens the 「短信」 tab and waits for the row of `code` · `variant`. */
export async function openSms(code = 'SMS_CODE', variant = 'default'): Promise<HTMLElement> {
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

/** The cell of `code` under the column titled 站内信 / 推送 / 短信. */
export function channelCell(code: string, channel: keyof typeof CHANNEL_TITLE): HTMLElement {
  const panel = panelOf(CHANNELS_TAB);
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with the channel columns').not.toBeNull();
  const titles = Array.from(header!.children, (cell) => squash(cell.textContent));
  const title = CHANNEL_TITLE[channel];
  let index = titles.indexOf(title);
  if (index < 0) index = titles.findIndex((text) => text.startsWith(title));
  expect(index, `column ${title}`).toBeGreaterThanOrEqual(0);
  const cell = channelRow(code).children[index];
  expect(cell, `${code} / ${title}`).toBeDefined();
  return cell as HTMLElement;
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

// ---- dialogs -------------------------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    // A closed antd Drawer may stay mounted (rc-drawer drops ant-drawer-open).
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
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
export async function verify(modal: HTMLElement): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(within(modal).getByRole('button', { name: '验证并继续' }));
  await settle();
}
export async function cancelStepUp(modal: HTMLElement): Promise<void> {
  await click(within(modal).getByRole('button', { name: '取消' }));
  await settle();
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

// ---- drawer fields -------------------------------------------------------------------------

/** Field labels of the drawer (Form.Item label or aria-label). */
export const LABEL = {
  sign: /^\s*(?:短信)?签名/,
  template: /模板\s*CODE|模板编号|模板代码|template_code/i,
  type: /^\s*(?:模板)?类型/,
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

function dropdownOptions(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
    ),
  );
}
/** Chooses `option` in the select (antd or native) or radio group labelled `label`. */
export async function choose(scope: HTMLElement, label: RegExp, option: RegExp): Promise<void> {
  const combos = within(scope).queryAllByRole('combobox', { name: label, hidden: true });
  if (combos.length > 0) {
    expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
    const combo = combos[0]!;
    if (combo instanceof HTMLSelectElement) {
      const target = Array.from(combo.options).find((item) => option.test(item.text.trim()));
      expect(target, `option ${String(option)}`).toBeDefined();
      await act(async () => {
        fireEvent.change(combo, { target: { value: target!.value } });
      });
      return;
    }
    await act(async () => {
      fireEvent.mouseDown(combo);
    });
    let target: HTMLElement | undefined;
    await waitFor(() => {
      target = dropdownOptions().find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `option ${String(option)}`).toBeDefined();
    });
    await click(target!);
    return;
  }
  const groups = within(scope).queryAllByRole('radiogroup', { name: label, hidden: true });
  const radios =
    groups.length === 1
      ? within(groups[0]!).queryAllByRole('radio', { hidden: true })
      : within(scope).queryAllByRole('radio', { hidden: true });
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a select or radio option ${String(option)} for ${String(label)}`).toHaveLength(1);
  await click(target[0]!);
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

/** The submit button of the drawer (保存 / 提交 / 确认 / 验证并… / 测试发送…). */
export function submitOf(drawer: HTMLElement): HTMLElement {
  return action(drawer, /^(?:验证并|确认|提交|保存|测试发送)/);
}

/** Opens 【编辑】 (registered) or 【登记】 (unregistered) of an SMS row; returns its drawer. */
export async function openDrawer(code: string, variant = 'default'): Promise<HTMLElement> {
  await openSms(code, variant);
  const found = actions(smsRow(code, variant), /^(?:编辑|登记)/);
  expect(found, `one 编辑 / 登记 for ${code} · ${variant}`).toHaveLength(1);
  await click(found[0]!);
  return otherDialog();
}
