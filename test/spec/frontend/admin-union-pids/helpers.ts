import { createElement } from 'react';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { UnionsPage } from '../../../../apps/admin/src/pages/unions/index.ts';
import {
  createAccessControl,
  type PermissionSnapshot,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  BASE_URL,
  NOW,
  PIDS,
  PID,
  VERIFY,
  createServer,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// antd's first Modal / Select / DatePicker / Upload render of a file (cold CSS-in-JS in jsdom)
// takes seconds on a loaded runner.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → dialog → step-up → write → list). */
export const FLOW_TIMEOUT = 60_000;

export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['union.account_auth', 'union.pid'],
  stepUp: {
    'union.account_auth': { tier: 'totp', operations: {} },
    'union.pid': { tier: 'totp', operations: {} },
  },
};
/** Holds union.account_auth but not union.pid. */
export const ACCOUNTS_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: ['union.account_auth'],
  stepUp: { 'union.account_auth': { tier: 'totp', operations: {} } },
};

/** Field labels of the PID dialogs (antd Form.Item label or aria-label). */
export const LABEL = {
  platform: /平台/,
  account: /联盟账号|账号/,
  site: /site_?id|站点|网站/i,
  pid: /PID/i,
  scene: /场景/,
  reason: /原因|操作说明/,
  confirmedAt: /确认时间|忽略.*时间/,
} as const;
/** The 20902 notice: the row changed, refresh. */
export const CONFLICT = /已变化|已变更|已被.*修改|他人修改|冲突|刷新后重试|已重新读取|已刷新/;
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export async function mount(
  server: Server = createServer(),
  options: { snapshot?: PermissionSnapshot } = {},
) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => 'example-admin-token',
    onError: vi.fn(),
  });
  const snapshot = options.snapshot ?? PERMITTED;
  const clock = { now: () => NOW };
  const element = createAdminShell({
    router: 'memory',
    initialRoute: { menuId: 'unions' },
    permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
    account: { username: 'ops-yi', displayName: '运营' },
    environment: 'test',
    onLogout: vi.fn(),
    dataProvider,
    clock,
    renderPage: () => createElement(UnionsPage, { access: createAccessControl(snapshot), clock }),
  });
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(element);
  });
  return { server, directFetch, view: view! };
}

export function main(): HTMLElement {
  return screen.getByRole('main');
}
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
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

/** The 「推广位」 tab of /unions, or null when the page does not show it. */
export function pidsTab(): HTMLElement | null {
  return within(main()).queryByRole('tab', { name: '推广位' });
}
/** The panel of the 「推广位」 tab. */
export function panel(): HTMLElement {
  const tab = pidsTab();
  expect(tab, 'tab 推广位').not.toBeNull();
  const id = tab!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  const visible = within(main()).queryAllByRole('tabpanel');
  expect(visible, 'one visible tab panel').toHaveLength(1);
  return visible[0]!;
}
export async function showPids(): Promise<void> {
  await waitFor(() => expect(pidsTab(), 'tab 推广位').not.toBeNull());
  await click(pidsTab()!);
}
/** Opens the 「推广位」 tab and waits for the list (the active PID's row). */
export async function openPids(): Promise<void> {
  await showPids();
  await waitFor(() => expect(squash(panel().textContent)).toContain(PID.active));
  await waitFor(() => expect(rowsWith(PID.active)).toHaveLength(1));
}
/** Opens the 「推广位」 tab and waits until the first union-pids read was sent. */
export async function openPidsRead(server: Server): Promise<void> {
  await showPids();
  await waitFor(() => expect(server.requests('GET', PIDS).length).toBeGreaterThan(0));
}

function rowsWith(text: string): HTMLElement[] {
  const nodes = within(panel()).queryAllByText(text, { exact: true });
  const found = new Set<HTMLElement>();
  for (const node of nodes) {
    const row = node.closest<HTMLElement>('tr, [role="row"], [role="listitem"]');
    if (row !== null) found.add(row);
  }
  return [...found];
}
/** The semantic row (table row or list item) showing the PID `pid`. */
export function row(pid: string): HTMLElement {
  const found = rowsWith(pid);
  expect(found, `one row for PID ${pid}`).toHaveLength(1);
  return found[0]!;
}
export function hasRow(pid: string): boolean {
  return rowsWith(pid).length > 0;
}

/** Buttons and links of `scope` whose visible text or aria-label matches `name` (spaces ignored). */
export function actions(scope: HTMLElement, name: RegExp): HTMLElement[] {
  return [
    ...within(scope).queryAllByRole('button'),
    ...within(scope).queryAllByRole('link'),
  ].filter(
    (node) =>
      name.test(squash(node.textContent)) || name.test(squash(node.getAttribute('aria-label'))),
  );
}
export function action(scope: HTMLElement, name: RegExp): HTMLElement {
  const found = actions(scope, name);
  expect(found, `one action ${String(name)}`).toHaveLength(1);
  return found[0]!;
}
export function allActions(scope: HTMLElement): HTMLElement[] {
  return [...within(scope).queryAllByRole('button'), ...within(scope).queryAllByRole('link')];
}

function titleMatches(node: HTMLElement, title: RegExp): boolean {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  // Under NODE_ENV=test every antd Modal title gets the same id: look inside the dialog first.
  const labelled = ids.map(
    (id) =>
      node.querySelector(`[id="${id}"]`)?.textContent ?? document.getElementById(id)?.textContent,
  );
  const candidates = [
    node.getAttribute('aria-label'),
    node.querySelector('.ant-modal-title')?.textContent,
    ...labelled,
  ];
  return candidates.some((text) => text !== null && text !== undefined && title.test(text.trim()));
}
export function dialogs(title: RegExp): HTMLElement[] {
  return screen.queryAllByRole('dialog').filter((node) => titleMatches(node, title));
}
/** The one open dialog titled `title`. */
export async function dialog(title: RegExp): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    const open = dialogs(title);
    expect(open, `dialog ${String(title)}`).toHaveLength(1);
    found = open[0];
  });
  return found!;
}
export const STEP_UP_TITLE = /^二次验证/;
export function stepUpOpen(): boolean {
  return dialogs(STEP_UP_TITLE).length > 0;
}

/** The text input (or textarea) labelled `label` in `scope`. */
export function textbox(scope: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = within(scope)
    .queryAllByLabelText(label)
    .filter(
      (node): node is HTMLInputElement | HTMLTextAreaElement =>
        (node instanceof HTMLInputElement &&
          node.type !== 'file' &&
          node.getAttribute('role') !== 'combobox') ||
        node instanceof HTMLTextAreaElement,
    );
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}
/** Inputs labelled `label` in `scope` (none when the field is not shown). */
export function textboxes(scope: HTMLElement, label: RegExp): HTMLInputElement[] {
  return within(scope)
    .queryAllByLabelText(label)
    .filter(
      (node): node is HTMLInputElement =>
        node instanceof HTMLInputElement &&
        node.type !== 'file' &&
        node.getAttribute('role') !== 'combobox',
    );
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
  return scopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}

/**
 * Chooses `option` in the select (antd Select or native) or radio group labelled `label` inside
 * `scope`; returns the texts of every option that was offered.
 */
export async function choose(scope: HTMLElement, label: RegExp, option: RegExp): Promise<string[]> {
  const combos = within(scope).queryAllByRole('combobox', { name: label });
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
  const groups = within(scope).queryAllByRole('radiogroup', { name: label });
  const radios =
    groups.length === 1
      ? within(groups[0]!).queryAllByRole('radio')
      : within(scope).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a select or radio option ${String(option)} for ${String(label)}`).toHaveLength(1);
  await click(target[0]!);
  return radios.map(text);
}

/** Types a Beijing time `YYYY-MM-DD HH:mm:ss` into a datetime-local input or an antd picker. */
export async function fillTime(input: HTMLInputElement | HTMLTextAreaElement, beijing: string) {
  const value = input.type === 'datetime-local' ? beijing.replace(' ', 'T') : beijing;
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

/** The one file input of a dialog (antd Upload or a plain input). */
export function fileInput(scope: HTMLElement): HTMLInputElement {
  const inputs = scope.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs, 'one file input').toHaveLength(1);
  return inputs[0]!;
}
export async function chooseFile(scope: HTMLElement, file: File): Promise<void> {
  const input = fileInput(scope);
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  await settle();
}

/** The submit button of a PID dialog (「验证并…」/「确认…」/「提交」/「保存」). */
export function submit(form: HTMLElement): HTMLElement {
  return action(form, /^(?:验证并|确认|提交|保存)/);
}
export async function stepUp(form: HTMLElement): Promise<HTMLElement> {
  await click(submit(form));
  return dialog(STEP_UP_TITLE);
}
export async function verify(modal: HTMLElement): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(within(modal).getByRole('button', { name: '验证并继续' }));
  await settle();
}

export function assertWrite(request: RequestLog, value = 'test-totp-1'): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(value);
  expect(request.headers.has('Idempotency-Key')).toBe(false);
}
export function assertVerified(server: Server, count = 1): void {
  expect(server.requests('POST', VERIFY).map((r) => r.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: '123456' })),
  );
}
/** The input shows an error next to it (described by it, or inside its antd Form.Item). */
export function fieldError(input: HTMLElement): void {
  const ids = [input.getAttribute('aria-describedby'), input.getAttribute('aria-errormessage')]
    .filter(Boolean)
    .join(' ')
    .split(/\s+/);
  const messages = ids.map((id) => document.getElementById(id)).filter((node) => node !== null);
  const nearby = input
    .closest('.ant-form-item')
    ?.querySelector('[role="alert"], .ant-form-item-explain-error');
  expect(
    messages.some((node) => Boolean(node.textContent?.trim())) ||
      Boolean(nearby?.textContent?.trim()),
    'an error next to the field',
  ).toBe(true);
}

/** Opens 【登记推广位】 from the PID tab. */
export async function openRegister(): Promise<HTMLElement> {
  await openPids();
  await click(action(panel(), /^(?:登记|新增|添加)/));
  return dialog(/登记|新增|添加/);
}
export async function openEdit(pid: string): Promise<HTMLElement> {
  await openPids();
  await click(action(row(pid), /^修改/));
  return dialog(/修改/);
}
export async function openActivate(pid: string): Promise<HTMLElement> {
  await openPids();
  await click(action(row(pid), /^启用/));
  return dialog(/启用/);
}
export async function openRetire(pid: string): Promise<HTMLElement> {
  await openPids();
  await click(action(row(pid), /^停用/));
  return dialog(/停用/);
}
