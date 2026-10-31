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
  BEARER,
  TOTP_CODE,
  created,
  createServer,
  detailPath,
  snapshot as snapshotOf,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `recon`): no import
// of a page module, so a missing 【核销】 is an assertion failure, not an import error.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (list → drawer → dialog → step-up → write → list). */
export const FLOW_TIMEOUT = 60_000;

/** The write-off entry (design §2: 【核销】, R2 late success → W11, payout.execute). */
export const WRITE_OFF_ENTRY = /^核销/;
/** The row entry of the drawer (design §2: 【处理】【详情】). */
export const DETAIL_ENTRY = /^(?:详情|处理|查看)$/;
/** The submit button of the write-off dialog. */
export const CONFIRM = /^(?:确认核销|确认|确定|提交|核销)/;
export const CANCEL = /^取消$/;
/** The note field of the write-off dialog (optional, ≤ 200 after trimming). */
export const NOTE = /备注/;
/** The step-up dialog (totp tier). */
export const STEP_UP = /二次验证|动态码/;
/** The submit button of the step-up dialog. */
export const VERIFY_BUTTON = /^(?:验证并继续|验证|确认|确定)$/;

/** The success notice of a write-off. */
export const DONE = /已核销|核销成功|核销完成/;
/** The 20902 notice: the difference or the withdrawal changed meanwhile, refresh. */
export const CONFLICT = /已变化|已变更|已被.*处理|他人处理|冲突|刷新后重试|已重新读取|已刷新/;
/** The 20901 notice: the same request key with another body. */
export const CHANGED = /有变化|已变化|重新提交|内容.*不一致|冲突/;
/** The 40901 notice: the same request is still being handled. */
export const RUNNING = /处理中|进行中|稍后|正在/;

/** Column titles of the list (spaces removed; matched at the start of the title). */
export const STATUS_COLUMN = /^(?:差错单?)?状态/;

/** Servers made with createServer during a test send nothing outside the page's whitelist. */
afterEach(() => {
  const servers = created.splice(0);
  try {
    for (const server of servers)
      expect(
        server.unexpected().map((request) => `${request.method} ${request.path}`),
        'only the list / detail reads, the totp step-up and the write-off are requested',
      ).toEqual([]);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
}

/** Mounts the real admin shell on 资金 / 对账与差错 over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: server.fetch,
    getToken: () => BEARER,
    onError: vi.fn(),
  });
  const permissions = options.snapshot ?? snapshotOf(server.permissions);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        initialRoute: { menuId: 'recon' },
        permissionsProvider: async () => permissions,
        account: { username: 'fin-yi', displayName: '财务' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider,
      }),
    );
  });
  await settle();
  return { server, directFetch };
}

// ---- basics --------------------------------------------------------------------------------

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
export async function click(node: HTMLElement, twice = false): Promise<void> {
  await act(async () => {
    fireEvent.click(node);
    if (twice) fireEvent.click(node);
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
/** `word` as a whole token (not inside a longer [A-Za-z0-9_] run). */
function token(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`);
}
/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;
function textNodesOf(root: Node): Text[] {
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
/** The text nodes of `node` joined with spaces (a row's cells do not run into each other). */
function spacedText(node: Node): string {
  return textNodesOf(node)
    .map((text) => text.data)
    .join(' ');
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

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** Text inputs and textareas of `root` labelled (or with a placeholder) matching `label`. */
export function textFields(
  root: HTMLElement,
  label: RegExp,
): (HTMLInputElement | HTMLTextAreaElement)[] {
  const labelled = within(root).queryAllByLabelText(label);
  const placeholders = within(root).queryAllByPlaceholderText(label);
  return [...new Set([...labelled, ...placeholders])].filter(isTextField);
}
/** The one text input (or textarea) labelled `label` in `root`. */
export function textbox(root: HTMLElement, label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(root, label);
  expect(found, `one input labelled ${String(label)}`).toHaveLength(1);
  return found[0]!;
}

/** Open step-up dialogs. */
export function stepUpDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => STEP_UP.test(titleOf(node)));
}
/** Open write-off dialogs (the ones with the note field). */
export function writeOffDialogs(): HTMLElement[] {
  return openDialogs().filter(
    (node) => !STEP_UP.test(titleOf(node)) && textFields(node, NOTE).length > 0,
  );
}
/** The one open write-off dialog. */
export async function writeOffDialog(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(writeOffDialogs(), 'one write-off dialog with a note field').toHaveLength(1),
  );
  return writeOffDialogs()[0]!;
}
/** Open dialogs / drawers (not the write-off or step-up dialog) that show `ref`. */
export function drawersOf(ref: string): HTMLElement[] {
  const pattern = token(ref);
  const found = openDialogs().filter(
    (node) =>
      !STEP_UP.test(titleOf(node)) &&
      textFields(node, NOTE).length === 0 &&
      pattern.test(spacedText(node)),
  );
  return found.filter((node) => !found.some((other) => other !== node && node.contains(other)));
}

// ---- the 差错单 list -----------------------------------------------------------------------

const DIFFS_TAB = '差错单';
function tabsNamed(name: string): HTMLElement[] {
  return within(main())
    .queryAllByRole('tab', { hidden: true })
    .filter(
      (tab) =>
        squash(tab.textContent).startsWith(name) ||
        squash(tab.getAttribute('aria-label')).startsWith(name),
    );
}
/** Where the 差错单 list lives: the panel of the 差错单 tab, or the main area without tabs. */
export function scope(): HTMLElement {
  const found = tabsNamed(DIFFS_TAB);
  if (found.length === 0) return main();
  expect(found, `tab ${DIFFS_TAB}`).toHaveLength(1);
  const id = found[0]!.getAttribute('aria-controls');
  const owned = id === null || id === '' ? null : document.getElementById(id);
  if (owned !== null) return owned;
  const panels = within(main()).queryAllByRole('tabpanel');
  expect(panels, 'one visible tab panel').toHaveLength(1);
  return panels[0]!;
}

const ROW = 'tr, [role="row"], [role="listitem"], li';
/** The innermost rows of `root` whose text holds every token of `words`. */
export function rowsOf(root: HTMLElement, words: readonly string[]): HTMLElement[] {
  const patterns = words.map(token);
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = spacedText(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
export function rowOf(ref: string): HTMLElement {
  const found = rowsOf(scope(), [ref]);
  expect(found, `one row for ${ref}`).toHaveLength(1);
  return found[0]!;
}
/** Shows the 差错单 list (its tab when the page has tabs) and waits for the row of `ref`. */
export async function openDiffs(server: Server, ref: string): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      tabsNamed(DIFFS_TAB).length > 0 || server.reads().length > 0,
      'the 差错单 tab or a read of the list',
    ).toBe(true),
  );
  const tab = tabsNamed(DIFFS_TAB)[0];
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') await click(tab);
  await waitFor(() => expect(rowsOf(scope(), [ref])).toHaveLength(1));
  return scope();
}

/** Text of the status cell of the row `ref`. */
export function statusCell(ref: string): string {
  const panel = scope();
  const header =
    panel.querySelector<HTMLElement>('thead tr') ??
    Array.from(panel.querySelectorAll<HTMLElement>('[role="row"]')).find(
      (node) => node.querySelector('[role="columnheader"]') !== null,
    ) ??
    null;
  expect(header, 'a header row with column titles').not.toBeNull();
  const titles = Array.from(header!.children, (cell) => squash(cell.textContent));
  const indexes = titles.flatMap((text, index) => (STATUS_COLUMN.test(text) ? [index] : []));
  expect(indexes, `one status column among ${titles.join(' | ')}`).toHaveLength(1);
  const cell = rowOf(ref).children[indexes[0]!];
  expect(cell, `${ref} / status`).toBeDefined();
  return squash(spacedText(cell!));
}

/** Opens the drawer of the row `ref` (its 【详情】, else 【处理】 / 【查看】). */
export async function openDetail(server: Server, ref: string, id: string): Promise<HTMLElement> {
  await openDiffs(server, ref);
  const row = rowOf(ref);
  const entries = usable(row, DETAIL_ENTRY);
  expect(entries.length, `a usable 【详情】 / 【处理】 for ${ref}`).toBeGreaterThan(0);
  const preferred = entries.find((node) => /^详情$/.test(squash(node.textContent))) ?? entries[0]!;
  const reads = server.detailReads(id).length;
  await click(preferred);
  await waitFor(() => expect(server.detailReads(id).length).toBeGreaterThan(reads));
  await settled(server);
  await waitFor(() => expect(drawersOf(ref), `the drawer of ${ref}`).toHaveLength(1));
  return drawersOf(ref)[0]!;
}

/** Every 【核销】 for `ref` (usable or not), in its row and in its open drawer. */
export function allWriteOffEntries(ref: string): HTMLElement[] {
  const scopes = [...rowsOf(scope(), [ref]), ...drawersOf(ref)];
  return [...new Set(scopes.flatMap((node) => actions(node, WRITE_OFF_ENTRY)))];
}
/** Usable 【核销】 entries for `ref`. */
export function writeOffEntries(ref: string): HTMLElement[] {
  return allWriteOffEntries(ref).filter((node) => !isDisabled(node));
}

/** Opens the write-off dialog of `ref` from its drawer (or its row). */
export async function openWriteOff(server: Server, ref: string, id: string): Promise<HTMLElement> {
  if (drawersOf(ref).length === 0) await openDetail(server, ref, id);
  const entries = writeOffEntries(ref);
  expect(entries.length, `a usable 【核销】 for ${ref}`).toBeGreaterThan(0);
  await click(entries[0]!);
  return writeOffDialog();
}

/** Presses the submit button of the write-off dialog (twice in one go when asked). */
export async function pressConfirm(modal: HTMLElement, twice = false): Promise<void> {
  await click(action(modal, CONFIRM), twice);
  await settle();
}

/** The one open step-up dialog. */
export async function stepUp(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'one step-up (动态码) dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** Types the totp code into the step-up dialog and presses its submit button. */
export async function verify(modal: HTMLElement, twice = false): Promise<void> {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), TOTP_CODE);
  await click(action(modal, VERIFY_BUTTON), twice);
  await settle();
}

/**
 * Confirms the open write-off dialog (with `note` typed when given), passes the step-up and waits
 * for the write-off request. No write-off is sent before the step-up is passed.
 */
export async function confirmAndVerify(
  server: Server,
  modal: HTMLElement,
  id: string,
  note?: string,
): Promise<void> {
  const sent = server.writeOffs(id).length;
  if (note !== undefined) await fill(textbox(modal, NOTE), note);
  await pressConfirm(modal);
  const dialog = await stepUp();
  expect(server.writeOffs(id), 'no write-off before the step-up').toHaveLength(sent);
  await verify(dialog);
  await waitFor(() => expect(server.writeOffs(id)).toHaveLength(sent + 1));
  await settled(server);
}

// ---- fields --------------------------------------------------------------------------------

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

// ---- text that appeared after an action ----------------------------------------------------

/** Notices: alerts, status lines, antd message / notification, antd Alert, form explains. */
const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-form-item-explain';

export type TextSnapshot = ReadonlyMap<Text, string>;
/** Every text node on the page with its text, taken before an action. */
export function snapshotText(): TextSnapshot {
  return new Map(textNodesOf(document.body).map((node): [Text, string] => [node, node.data]));
}
function changedSince(before: TextSnapshot, keep: (element: Element) => boolean): string {
  return squash(
    textNodesOf(document.body)
      .filter((node) => {
        const element = node.parentElement;
        if (before.get(node) === node.data || element === null) return false;
        if (element.closest('textarea') !== null || !visible(element)) return false;
        return keep(element);
      })
      .map((node) => node.data)
      .join(''),
  );
}
/** New (or changed) text since `before` in notices and in dialogs / drawers. */
export function freshText(before: TextSnapshot): string {
  return changedSince(
    before,
    (element) => element.closest('[role="dialog"]') !== null || element.closest(NOTICES) !== null,
  );
}
/** New (or changed) text since `before` in notices only (alerts, messages, form explains). */
export function freshNotices(before: TextSnapshot): string {
  return changedSince(before, (element) => element.closest(NOTICES) !== null);
}
/** `text` tells `count` released withdrawal holds (the number next to 冻结). */
export function tellsReleased(text: string, count: number): boolean {
  const n = `(?<!\\d)${count}(?!\\d)`;
  return new RegExp(`${n}\\D{0,12}冻结|冻结\\D{0,12}${n}`).test(text);
}

// ---- requests ------------------------------------------------------------------------------

/** The Idempotency-Key header of a request (null when missing). */
export function requestKey(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}
/** The X-Step-Up-Token header of a request (null when missing). */
export function stepUpHeader(request: RequestLog): string | null {
  return request.headers.get('X-Step-Up-Token');
}
/**
 * A write-off request: bearer, a handed-out step-up value, an Idempotency-Key, and the body
 * {expected_withdrawal_status: 'APPROVED'} plus the trimmed note when one was typed — no
 * amount, channel result or evidence of the console's own.
 */
export function assertWriteOff(server: Server, request: RequestLog, note?: string): void {
  expect(request.headers.get('Authorization')).toBe(`Bearer ${BEARER}`);
  const value = requestKey(request);
  expect(value, 'an Idempotency-Key header').not.toBeNull();
  expect(value!.trim(), 'a non-empty Idempotency-Key').not.toBe('');
  const proof = stepUpHeader(request);
  expect(proof, 'an X-Step-Up-Token header').not.toBeNull();
  expect(server.issued(), 'a step-up value the server handed out').toContain(proof);
  const body = request.body as Record<string, unknown> | undefined;
  expect(body, 'a JSON body').toBeDefined();
  expect(body!['expected_withdrawal_status']).toBe('APPROVED');
  if (note === undefined) {
    expect(Object.keys(body!), 'no note when none was typed').toEqual([
      'expected_withdrawal_status',
    ]);
  } else {
    expect(Object.keys(body!).sort()).toEqual(['expected_withdrawal_status', 'note']);
    expect(typeof body!['note']).toBe('string');
    expect((body!['note'] as string).trim()).toBe(note.trim());
  }
}
/** Every step-up request asked for the totp tier with the typed code. */
export function assertTotp(server: Server): void {
  for (const request of server.verifies())
    expect(request.body).toEqual({ tier: 'totp', code: TOTP_CODE });
}
/** The detail of `id` was read more than `count` times. */
export async function readAgain(server: Server, id: string, count: number): Promise<void> {
  await waitFor(() =>
    expect(
      server.requests('GET', detailPath(id)).length,
      'the detail is read again',
    ).toBeGreaterThan(count),
  );
}
