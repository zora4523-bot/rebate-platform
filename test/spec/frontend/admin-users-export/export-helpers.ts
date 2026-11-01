// F1-07je jsdom kit. The users list is reached only through the real admin shell (menu `users`);
// no page module is imported, so a missing entry is an assertion failure. Every server a test
// mounts is checked after the test: only the list read and the requests the test declared (the
// export POST, the step-up of the full-number path, 导出记录, the detail) may have gone out.
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
  EXPORTS,
  OTP,
  RISK_NAME,
  UID,
  VERIFY,
  type RequestLog,
  type RiskState,
  type Server,
} from './export-fixtures.ts';

// antd's first Modal / Select render of a file (cold CSS-in-JS in jsdom) takes seconds on a
// loaded runner.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → export → step-up → POST → notice). */
export const FLOW_TIMEOUT = 90_000;

const TOTP = { tier: 'totp', operations: {} } as const;
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
/** export and user.list, no pii.*. */
export const EXPORTER: PermissionSnapshot = {
  isSuper: false,
  permissions: ['user.list', 'export'],
};
/** export, user.list and pii.reveal_phone (totp). */
export const EXPORTER_PII: PermissionSnapshot = {
  isSuper: false,
  permissions: ['user.list', 'export', 'pii.reveal_phone'],
  stepUp: { 'pii.reveal_phone': TOTP },
};
/** Every users point, no export. */
export const NO_EXPORT: PermissionSnapshot = {
  isSuper: false,
  permissions: ['user.list', 'user.lookup', 'pii.reveal_phone'],
  stepUp: { 'pii.reveal_phone': TOTP },
};
/** export and user.lookup, no user.list. */
export const EXPORT_LOOKUP: PermissionSnapshot = {
  isSuper: false,
  permissions: ['user.lookup', 'export'],
};
/** user.lookup only. */
export const LOOKUP_ONLY: PermissionSnapshot = { isSuper: false, permissions: ['user.lookup'] };

const mounted: Server[] = [];
afterEach(() => {
  const servers = mounted.splice(0);
  cleanup();
  vi.unstubAllGlobals();
  for (const server of servers)
    expect(server.strays(), 'only the list read and the requests this test declared').toEqual([]);
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

function canList(snapshot: PermissionSnapshot): boolean {
  return snapshot.isSuper || snapshot.permissions.includes('user.list');
}

/** Mounts the real shell on 用户查询 over `server` and waits for the page (and its list). */
export async function mount(server: Server, snapshot: PermissionSnapshot = SUPER) {
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
  await waitFor(() => pageHeading());
  if (canList(snapshot)) await listed();
  await settled(server);
  return { server, directFetch };
}

/** Drops the current mount (its server stays checked after the test). */
export function unmountAll(): void {
  cleanup();
  vi.unstubAllGlobals();
}

/** Waits for the list row of `uid` (its 【详情 <UID>】). */
export async function listed(uid = UID): Promise<void> {
  await waitFor(() =>
    expect(
      within(main()).queryAllByRole('button', { name: `详情 ${uid}` }),
      `【详情 ${uid}】 on the list`,
    ).toHaveLength(1),
  );
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
export async function fill(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

// ---- text ----------------------------------------------------------------------------------

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
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

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.style.display === 'none' || node.hidden)) return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (node.classList.contains('ant-popover-hidden')) return false;
    if (node.classList.contains('ant-select-dropdown-hidden')) return false;
  }
  return true;
}

// ---- entries -------------------------------------------------------------------------------

/** 【导出】 (spaces removed: antd may put one between two characters). */
export const EXPORT = /^导出$/;
/** 【导出记录】. */
export const RECORDS = /^导出记录$/;
/** Either entry. */
export const ANY_ENTRY = /^导出(?:记录)?$/;

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

/** The page's 用户查询 heading. */
export function pageHeading(): HTMLElement {
  const found = within(main()).queryAllByRole('heading', { name: '用户查询' });
  expect(found, 'one 用户查询 heading').toHaveLength(1);
  return found[0]!;
}
/**
 * The list's title row: the smallest block around the 用户查询 heading that holds an action
 * named `name`; it holds neither the filter card nor the table.
 */
export function titleRow(name: RegExp = ANY_ENTRY): HTMLElement {
  let found = pageHeading().parentElement;
  while (found !== null && found !== main() && actions(found, name).length === 0)
    found = found.parentElement;
  const row = required(found, 'a title row with the entry');
  expect(row, `the title row (beside 用户查询) holds ${String(name)}`).not.toBe(main());
  expect(within(row).queryAllByRole('table'), 'the title row is not the list').toEqual([]);
  expect(within(row).queryAllByRole('combobox'), 'the title row is not the filter card').toEqual(
    [],
  );
  return row;
}
/** Waits for one usable 【导出】 and one 【导出记录】 in the title row (and no other 【导出】). */
export async function expectEntries(): Promise<void> {
  await waitFor(() => {
    expect(usable(titleRow(EXPORT), EXPORT), 'one usable 【导出】 in the title row').toHaveLength(
      1,
    );
    expect(actions(titleRow(RECORDS), RECORDS), 'one 【导出记录】 in the title row').toHaveLength(
      1,
    );
    expect(actions(main(), EXPORT), 'one 【导出】 on the page').toHaveLength(1);
  });
}
/** Waits for the one usable 【导出】 of the title row. */
export async function exportEntry(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(usable(titleRow(EXPORT), EXPORT), 'one usable 【导出】 in the title row').toHaveLength(
      1,
    ),
  );
  return usable(titleRow(EXPORT), EXPORT)[0]!;
}
/** Waits for the one 【导出记录】 of the title row. */
export async function recordsEntry(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(usable(titleRow(RECORDS), RECORDS), 'one 【导出记录】 in the title row').toHaveLength(1),
  );
  return usable(titleRow(RECORDS), RECORDS)[0]!;
}
/** Presses every 【导出】 of the main area that is disabled (it must do nothing). */
export async function pressDisabled(): Promise<void> {
  for (const node of actions(main(), EXPORT).filter(isDisabled)) {
    await click(node);
    await settle();
  }
}

// ---- list filter ---------------------------------------------------------------------------

/** Chooses `state` (or 全部) in the list's 风控状态 filter and waits for the list read. */
export async function filterRisk(server: Server, state: RiskState | 'all'): Promise<void> {
  const reads = server.listQueries().length;
  const combo = required(
    within(main()).queryByRole('combobox', { name: /风控状态/ }),
    'the labelled 风控状态 filter',
  );
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  const label = state === 'all' ? '全部' : RISK_NAME[state];
  // The visible option, not rc-select's virtual accessibility mirror.
  const option = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    ).find((node) => node.textContent?.trim() === label);
  await waitFor(() => expect(option(), `option ${label}`).toBeDefined());
  await click(option()!);
  await waitFor(() => expect(server.listQueries().length).toBeGreaterThan(reads));
  await waitFor(() =>
    expect(server.listQueries().at(-1)?.['risk_state']).toBe(state === 'all' ? undefined : state),
  );
  await settled(server);
}
/** Goes to the next page of the list. */
export async function nextPage(server: Server): Promise<void> {
  const reads = server.listQueries().length;
  const next = required(
    main().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    ),
    'the pagination next control',
  );
  await click(next);
  await waitFor(() => expect(server.listQueries().length).toBeGreaterThan(reads));
  await settled(server);
}

// ---- dialogs -------------------------------------------------------------------------------

/** The title of the step-up dialog (apps/admin StepUpModal, totp tier). */
export const STEP_UP_TITLE = /二次验证|动态码/;
const VERIFY_BUTTON = /^验证并继续$/;
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;

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
/** Open layers other than the step-up dialog, outside the main area (the export dialog). */
export function confirmations(): HTMLElement[] {
  return openLayers().filter((node) => !isStepUp(node) && node.closest('main') === null);
}
/** Controls inside a field (choices, toggles, selects) are never the dialog's submit. */
const FIELD_PARTS =
  '.ant-modal-close, .ant-select, .ant-checkbox-wrapper, .ant-switch, [role="switch"], .ant-radio-group, .ant-radio-wrapper, .ant-segmented, [role="radiogroup"], label';
/** The submit button of the export dialog: its one button that does not dismiss it. */
export function submitOf(layer: HTMLElement): HTMLElement {
  const buttons = Array.from(layer.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (node) =>
      node.closest(FIELD_PARTS) === null &&
      squash(node.textContent) !== '' &&
      !/导出记录/.test(nameOf(node)) &&
      !DISMISS.test(squash(node.textContent)) &&
      !DISMISS.test(squash(node.getAttribute('aria-label'))),
  );
  expect(
    buttons.map((node) => squash(node.textContent)),
    'one submit button in the export dialog',
  ).toHaveLength(1);
  return buttons[0]!;
}
/** Closes every export dialog still open (its 【取消】 / 【关闭】 / 【知道了】 or ×). */
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
  await waitFor(() => expect(confirmations(), 'no export dialog left').toEqual([]));
}
/** Waits for the step-up dialog. */
export async function stepUp(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'the step-up dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** Types the code into the step-up dialog and presses 【验证并继续】; waits for the verify. */
export async function verify(server: Server): Promise<void> {
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
  await click(submit[0]!);
  await waitFor(() => expect(server.verifies().length).toBe(verifies + 1));
}

// ---- the full-number option ----------------------------------------------------------------

/** What the optional 「导出完整手机号」 choice may be called. */
export const UNMASK = /完整手机号|完整号码|完整的手机号|明文|不脱敏|未脱敏|原始手机号/;
const TOGGLES =
  'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]';

function toggleLabel(node: HTMLElement): string {
  const parts: string[] = [node.getAttribute('aria-label') ?? ''];
  for (const id of (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean))
    parts.push(document.getElementById(id)?.textContent ?? '');
  let labels: HTMLLabelElement[] = [];
  if (node instanceof HTMLInputElement && node.labels !== null) labels = Array.from(node.labels);
  else if (node instanceof HTMLButtonElement) labels = Array.from(node.labels);
  for (const label of labels) parts.push(label.textContent ?? '');
  parts.push(node.closest('label')?.textContent ?? '');
  parts.push(node.textContent ?? '');
  return squash(parts.join(' '));
}
/** The visible full-number choices on the page or in a dialog (never in the list table). */
export function unmaskOptions(): HTMLElement[] {
  const found = Array.from(document.body.querySelectorAll<HTMLElement>(TOGGLES)).filter(
    (node) => visible(node) && node.closest('table') === null && UNMASK.test(toggleLabel(node)),
  );
  return [...new Set(found)];
}
export function isChecked(node: HTMLElement): boolean {
  return node instanceof HTMLInputElement
    ? node.checked
    : node.getAttribute('aria-checked') === 'true';
}
/** Waits until the one full-number choice is ticked (`ticked`) or not. */
async function expectTicked(ticked: boolean): Promise<void> {
  await waitFor(() => {
    const options = unmaskOptions();
    expect(options, 'one full-number choice').toHaveLength(1);
    expect(isChecked(options[0]!), `the full-number choice is ticked: ${ticked}`).toBe(ticked);
  });
}

// ---- exporting -----------------------------------------------------------------------------

/**
 * Presses 【导出】 (twice when `twice`) and waits until a POST went out or one export dialog
 * opened; returns that dialog (undefined when the POST went straight out).
 */
export async function pressExport(server: Server, twice = false): Promise<HTMLElement | undefined> {
  const posts = server.exportPosts().length;
  const entry = await exportEntry();
  await act(async () => {
    fireEvent.click(entry);
    if (twice) fireEvent.click(entry);
  });
  await waitFor(() =>
    expect(
      server.exportPosts().length > posts || confirmations().length === 1,
      'a POST /admin/v1/exports or one export dialog after 【导出】',
    ).toBe(true),
  );
  expect(stepUpDialogs(), 'no step-up for a masked export').toEqual([]);
  if (server.exportPosts().length > posts) return undefined;
  return confirmations()[0]!;
}

export interface Sent {
  /** The export request. */
  readonly post: RequestLog;
  /** The page's text just before the export was sent (or its dialog submitted). */
  readonly prior: Before;
}
/**
 * The masked export: 【导出】, then the dialog's submit when it asks (the full-number choice left
 * unticked); `twice` presses each step twice. Waits for the one POST.
 */
export async function exportMasked(server: Server, twice = false): Promise<Sent> {
  const posts = server.exportPosts().length;
  for (const option of unmaskOptions())
    expect(isChecked(option), 'the full-number choice starts unticked').toBe(false);
  let prior = before();
  const layer = await pressExport(server, twice);
  if (layer !== undefined) {
    for (const option of unmaskOptions())
      expect(isChecked(option), 'the full-number choice starts unticked').toBe(false);
    expect(server.exportPosts(), 'nothing sent while the dialog asks').toHaveLength(posts);
    prior = before();
    const submit = submitOf(layer);
    await act(async () => {
      fireEvent.click(submit);
      if (twice) fireEvent.click(submit);
    });
  }
  await waitFor(() => expect(server.exportPosts().length).toBe(posts + 1));
  expect(stepUpDialogs(), 'no step-up for a masked export').toEqual([]);
  return { post: server.exportPosts().at(-1)!, prior };
}

/**
 * Ticks the full-number choice (on the page, else in the export dialog). False when the page
 * offers none (allowed): then any dialog is closed again, and a POST may have gone straight out.
 */
export async function tickUnmasked(server: Server): Promise<boolean> {
  const onPage = unmaskOptions();
  if (onPage.length > 0) {
    expect(onPage, 'one full-number choice').toHaveLength(1);
    expect(isChecked(onPage[0]!), 'the full-number choice starts unticked').toBe(false);
    await click(onPage[0]!);
    await expectTicked(true);
    return true;
  }
  const layer = await pressExport(server);
  if (layer === undefined) return false;
  const inDialog = unmaskOptions();
  if (inDialog.length === 0) {
    await closeConfirmations();
    return false;
  }
  expect(inDialog, 'one full-number choice').toHaveLength(1);
  expect(isChecked(inDialog[0]!), 'the full-number choice starts unticked').toBe(false);
  await click(inDialog[0]!);
  await expectTicked(true);
  return true;
}
/** Unticks the full-number choice again (a radio: by choosing the masked one beside it). */
export async function untickUnmasked(): Promise<void> {
  const options = unmaskOptions();
  expect(options, 'one full-number choice').toHaveLength(1);
  const option = options[0]!;
  const radio =
    option instanceof HTMLInputElement
      ? option.type === 'radio'
      : option.getAttribute('role') === 'radio';
  if (!radio) {
    await click(option);
  } else {
    const group =
      option.closest('[role="radiogroup"], .ant-radio-group') ??
      option.closest('[role="dialog"]') ??
      main();
    const others = Array.from(
      group.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]'),
    ).filter((node) => node !== option && visible(node) && !UNMASK.test(toggleLabel(node)));
    expect(others.length, 'a masked choice beside the full-number one').toBeGreaterThan(0);
    await click(others[0]!);
  }
  await expectTicked(false);
}

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
function reasonFields(scope: HTMLElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  const labelled = within(scope).queryAllByLabelText(/原因/);
  const placeholders = within(scope).queryAllByPlaceholderText(/原因/);
  return [...new Set([...labelled, ...placeholders])].filter(isTextField);
}
/** Where the reason is asked: the open export dialog, else the main area. */
export function reasonScope(): HTMLElement {
  const layers = confirmations();
  return layers.length === 1 ? layers[0]! : main();
}
/**
 * The reason input of the full-number export: in the open export dialog, on the page, or in the
 * dialog 【导出】 opens (nothing is sent before it).
 */
export async function reasonInput(server: Server): Promise<HTMLInputElement | HTMLTextAreaElement> {
  if (confirmations().length === 0 && reasonFields(main()).length === 0) {
    const posts = server.exportPosts().length;
    await click(await exportEntry());
    await waitFor(() =>
      expect(confirmations(), 'the export dialog asks for the reason').toHaveLength(1),
    );
    expect(server.exportPosts(), 'nothing sent before the reason').toHaveLength(posts);
  }
  await waitFor(() => expect(reasonFields(reasonScope()), 'one reason input').toHaveLength(1));
  return reasonFields(reasonScope())[0]!;
}
/** What sends the full-number export on: the export dialog's submit, else 【导出】. */
export async function submitter(): Promise<HTMLElement> {
  const layers = confirmations();
  if (layers.length === 1) return submitOf(layers[0]!);
  // Greyed or not: a page may hold 【导出】 until the reason is valid.
  await waitFor(() =>
    expect(actions(titleRow(EXPORT), EXPORT), 'one 【导出】 in the title row').toHaveLength(1),
  );
  return actions(titleRow(EXPORT), EXPORT)[0]!;
}
/**
 * The full-number export after `tickUnmasked`: types `reason`, submits, checks that nothing is
 * sent before the step-up, verifies and waits for the POST.
 */
export async function sendUnmasked(server: Server, reason: string): Promise<Sent> {
  await fill(await reasonInput(server), reason);
  const posts = server.exportPosts().length;
  const submit = await submitter();
  const prior = before();
  await click(submit);
  await stepUp();
  expect(server.exportPosts(), 'nothing sent before the step-up').toHaveLength(posts);
  await verify(server);
  await waitFor(() => expect(server.exportPosts().length).toBe(posts + 1));
  await settled(server);
  return { post: server.exportPosts().at(-1)!, prior };
}

// ---- requests ------------------------------------------------------------------------------

/** The step-up grant a request carried. */
export function passOf(request: { readonly headers: Headers }): string | null {
  return request.headers.get('X-Step-Up-Token');
}
function bodyParts(post: RequestLog): { sent: unknown; rest: Record<string, unknown> } {
  const body = post.body;
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'a JSON object').toBe(
    true,
  );
  const { filters: sent, ...rest } = body as Record<string, unknown>;
  return { sent, rest };
}
/**
 * A masked export: POST /admin/v1/exports with exactly {resource: users, filters} (filters may be
 * left out when empty), no unmasked / reason / identity fields, no step-up grant, no
 * Idempotency-Key.
 */
export function expectMasked(post: RequestLog, filters: Readonly<Record<string, string>>): void {
  expect(post.method).toBe('POST');
  expect(post.path).toBe(EXPORTS);
  expect(post.query).toEqual({});
  const { sent, rest } = bodyParts(post);
  expect(rest, 'only resource besides filters').toStrictEqual({ resource: 'users' });
  expect(sent ?? {}, 'the applied filters, no paging').toStrictEqual(filters);
  expect(passOf(post), 'no X-Step-Up-Token').toBeNull();
  expect(post.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
}
/**
 * A full-number export: {resource: users, filters, unmasked: true, reason}, a fresh grant from a
 * step-up sent before it, no Idempotency-Key.
 */
export function expectUnmasked(
  server: Server,
  post: RequestLog,
  filters: Readonly<Record<string, string>>,
  reason: string,
): void {
  expect(post.method).toBe('POST');
  expect(post.path).toBe(EXPORTS);
  expect(post.query).toEqual({});
  const { sent, rest } = bodyParts(post);
  expect(rest).toStrictEqual({ resource: 'users', unmasked: true, reason });
  expect(sent ?? {}, 'the applied filters, no paging').toStrictEqual(filters);
  expect(post.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
  expect(passOf(post), 'X-Step-Up-Token').not.toBeNull();
  expect(server.issued).toContain(passOf(post));
  const sentAt = server.log.indexOf(post);
  const verified = server.log.findIndex((one) => one.method === 'POST' && one.path === VERIFY);
  expect(verified, 'a step-up before the export').toBeGreaterThanOrEqual(0);
  expect(sentAt).toBeGreaterThan(verified);
}

// ---- text that appeared after an action ----------------------------------------------------

const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-result, .ant-form-item-explain';
const LAYERS = '[role="dialog"], [role="alertdialog"], .ant-popconfirm';
/** Character counters of an input (antd showCount); their 「n / 200」 is never a hint. */
const COUNTERS = '.ant-input-data-count, .ant-input-show-count-suffix';

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
function shown(node: Text): boolean {
  const element = node.parentElement;
  return (
    element !== null &&
    visible(element) &&
    element.closest(`textarea, ${COUNTERS}`) === null &&
    node.data.trim() !== ''
  );
}
export interface Before {
  readonly nodes: ReadonlyMap<Text, string>;
  /** Every visible text on the page (trimmed): a re-rendered dialog does not make them new. */
  readonly strings: ReadonlySet<string>;
}
/** The page's text, taken before an action. */
export function before(): Before {
  const nodes = textNodes();
  return {
    nodes: new Map(nodes.map((node): [Text, string] => [node, node.data])),
    strings: new Set(nodes.filter(shown).map((node) => node.data.trim())),
  };
}
/** Toasts: a new one counts even when an earlier one said the same. */
const TOASTS = '.ant-message-notice, .ant-notification-notice';
function freshNodes(prior: Before): Text[] {
  return textNodes().filter(
    (node) =>
      shown(node) &&
      ((!prior.nodes.has(node) && node.parentElement!.closest(TOASTS) !== null) ||
        (prior.nodes.get(node) !== node.data && !prior.strings.has(node.data.trim()))),
  );
}
function join(nodes: readonly Text[]): string {
  return squash(nodes.map((node) => node.data).join('')).replace(/\d+[/／]\d+/g, '');
}
/** New text in notices and dialogs (a table cell or the title row does not count). */
export function freshText(prior: Before): string {
  return join(
    freshNodes(prior).filter(
      (node) => node.parentElement!.closest(`${LAYERS}, ${NOTICES}`) !== null,
    ),
  );
}
/** A new notice or dialog text says `pattern`. */
export async function announce(prior: Before, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(freshText(prior), `a notice ${String(pattern)}`).toMatch(pattern));
}

/**
 * 「已创建导出任务」 and the like (a 「未创建成功」, 「没有成功创建」 or a word about 导出记录 is
 * not).
 */
export const SUCCESS =
  /(?<![未没不非有])(?:已|成功)(?:创建|提交|发起)[^，。；,;！!]{0,6}导出(?!记录)|导出(?!记录)[^，。；,;！!]{0,6}?(?<![未没不非])(?:已创建|创建成功|已提交|提交成功|已发起|发起成功)/;
/** A new notice says the task was created and points to 导出记录. */
export async function announceSuccess(prior: Before): Promise<void> {
  await waitFor(() => {
    const text = freshText(prior);
    expect(text, 'a notice that the export task was created').toMatch(SUCCESS);
    expect(text, 'the notice points to 导出记录').toMatch(/导出记录/);
  });
}
/** The page shows the existing 导出记录 page (its heading). */
export function onRecords(): boolean {
  return within(main()).queryAllByRole('heading', { name: '导出记录' }).length === 1;
}
/**
 * After a created task: 导出记录 (reached by the title row's entry, unless the page went there by
 * itself) lists the task `id`.
 */
export async function seeTask(id: string): Promise<void> {
  if (!onRecords()) {
    if (confirmations().length > 0) await closeConfirmations();
    await click(await recordsEntry());
  }
  await waitFor(() => expect(onRecords(), 'the 导出记录 page').toBe(true));
  await waitFor(() =>
    expect(within(main()).queryAllByRole('cell', { name: id }), `task ${id} listed`).toHaveLength(
      1,
    ),
  );
}
/** No new notice or dialog text says an export task was created. */
export function expectNoSuccess(prior: Before): void {
  expect(freshText(prior), 'no export-created notice').not.toMatch(SUCCESS);
}

/** What the operator is told after a refused or failed export (only new text counts). */
export const HINT = {
  forbidden: /权限/,
  failed: /网络|失败|异常|稍后|未能|没能|未成功/,
  invalid: /有误|不正确|不符合|无效|参数|条件|筛选|错误|失败/,
  /** States the reason rule (a bare 「4 / 200」 counter, 「原因」 or 「参数错误」 does not). */
  reason:
    /必填|不能为空|不可为空|不得为空|请填写|请输入|\d+\s*个?字|不超过|不能超过|超过|超出|最多|至多|过长|太长/,
} as const;
/** The reason rule stated where a submit is held disabled (a counter alone does not). */
export const REASON_RULE =
  /必填|不能为空|不可为空|不得为空|请填写|\d+\s*个?字|不超过|不能超过|最多|至多/;

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
  return squash(parts.join('')).replace(/\d+[/／]\d+/g, '');
}
/**
 * New hint text beside the reason input (its form item, described-by / error targets, the
 * dialog's alerts; labels and counters left out). With `orNotice` (nothing was sent) a new
 * alert, message or notification anywhere counts too.
 */
export function reasonHint(prior: Before, orNotice: boolean): string {
  const scope = reasonScope();
  const fields = reasonFields(scope);
  const areas: HTMLElement[] =
    scope === main()
      ? []
      : Array.from(
          scope.querySelectorAll<HTMLElement>('[role="alert"], .ant-form-item-explain, .ant-alert'),
        );
  const field = fields[0];
  if (field !== undefined) {
    const item = field.closest<HTMLElement>('.ant-form-item');
    if (item !== null) areas.push(item);
    for (const name of ['aria-describedby', 'aria-errormessage'])
      for (const id of (field.getAttribute(name) ?? '').split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(id);
        if (target !== null) areas.push(target);
      }
  }
  if (orNotice) areas.push(...Array.from(document.querySelectorAll<HTMLElement>(NOTICES)));
  return join(
    freshNodes(prior).filter(
      (node) =>
        node.parentElement!.closest('label, .ant-form-item-label') === null &&
        areas.some((area) => area.contains(node)),
    ),
  );
}
