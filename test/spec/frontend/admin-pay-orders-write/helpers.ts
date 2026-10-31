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
  REASONS,
  TOTP_CODE,
  VERIFY,
  createServer,
  detailRoute,
  dictNames,
  namePattern,
  snapshot as snapshotOf,
  type RequestLog,
  type Server,
} from './fixtures.ts';

// The pages are reached only through the real shell (createAdminShell, menu id `pay-orders`, or
// the detail address pay-orders/{pay_order_id}): no import of a page module, so a missing entry is
// an assertion failure, not an import error. antd's first Modal / Select render of a file is slow
// in jsdom.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (detail → dialog → write → detail). */
export const FLOW_TIMEOUT = 60_000;

/** The no-permission notice (10403, or no pay.view). */
export const FORBIDDEN = /无权限|没有.*权限|权限不足/;
/** A pay order / anomaly the server does not know (20001 with its id field). */
export const NOT_FOUND = /不存在|未找到|找不到|没有找到|无此/;
/** A refund was accepted and is under way (PROCESSING). */
export const ACCEPTED = /退款中|已受理|已提交|处理中/;
/** 20902: the pay order changed meanwhile (no longer PAID, or no longer PENDING / needs_manual). */
export const CONFLICT = /已变化|已变更|状态.*变|刷新后重试|已刷新|已重新读取|不是已支付|非已支付/;
/** 20901: the same request key with another body. */
export const CHANGED = /有变化|已变化|重新提交|内容.*不一致|冲突/;
/** 40901: the same request is still being handled. */
export const RUNNING = /处理中|进行中|稍后|正在/;
/** 【立即查询】 settled the pay order as paid (PO2). */
export const SETTLED_PAID = /已支付|支付成功/;
/** 【立即查询】 settled the pay order as closed (PO3). */
export const SETTLED_CLOSED = /已关闭|关单成功/;
/** 【立即查询】 changed nothing: still PENDING / needs_manual, query again later. */
export const UNCHANGED =
  /未变化|无变化|没有变化|仍(?:为|是|然)?待支付|仍未|稍后再查|稍后再试|稍后重试|未能确认|未确认/;

/** The refund entry: 【发起退款】 on a PAID pay order, 【退款】 on an anomaly. */
export const REFUND_ENTRY = /^(?:发起退款|原路退款|退款)$/;
/** The 【立即查询】 entry of a needs_manual pay order. */
export const RESOLVE_ENTRY = /^立即查询$/;
/** Every write entry of this part (a disabled one does nothing when pressed). */
export const WRITE_ENTRY = /^(?:发起退款|原路退款|退款|立即查询)$/;
/** The submit button of the refund dialog (design: 【确认退款】). */
export const SUBMIT = /^(?:确认|确定|提交)/;
export const CANCEL = /^取消$/;
/** The step-up dialog. */
export const STEP_UP_TITLE = /^二次验证/;

/** Field labels of the refund dialog (antd Form.Item label, aria-label or placeholder). */
export const LABEL = {
  /** The amount to refund (not the shown refundable amount). */
  amount: /^(?!.*可退).*金额/,
  reason: /原因/,
  note: /备注|说明/,
} as const;

/** The tabs of the list page (a count may follow the name). */
export const TAB = {
  anomalies: /^异常收款(?:\d+|[（(]\d+[)）])?$/,
} as const;

/** The servers mounted in this case, with the writes (method and path) each may receive. */
const mounted = new Map<Server, (readonly [string, string])[]>();

/**
 * Lets `server` receive the writes `allowed` in this case besides the four reads of F1-13a; any
 * other request, and any read of the refund list, fails the case after it ran (error and retry
 * paths included).
 */
export function permitWrites(server: Server, ...allowed: (readonly [string, string])[]): void {
  mounted.set(server, [...(mounted.get(server) ?? []), ...allowed]);
}

afterEach(() => {
  const checked = [...mounted];
  mounted.clear();
  try {
    cleanup();
    vi.unstubAllGlobals();
  } finally {
    for (const [server, allowed] of checked) {
      expect(server.refundReads(), 'the refund list is never read').toEqual([]);
      expect(server.unexpected(allowed), 'only the reads and the writes of this case').toEqual([]);
    }
  }
});

export interface MountOptions {
  /** Defaults to the server's own permission points. */
  readonly snapshot?: PermissionSnapshot;
  /** The address without its leading slash; defaults to the list (pay-orders). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 支付单 (or a detail address) over the fake server. */
export async function mount(server: Server = createServer(), options: MountOptions = {}) {
  if (!mounted.has(server)) mounted.set(server, []);
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
      }),
    );
  });
  await settle();
  return { server, directFetch };
}

/** Mounts the detail of `payOrderId` and waits until it shows its merchant order number. */
export async function openDetail(
  server: Server,
  payOrderId: string,
  outTradeNo: string,
  snapshot?: PermissionSnapshot,
): Promise<void> {
  await mount(server, {
    route: detailRoute(payOrderId),
    ...(snapshot === undefined ? {} : { snapshot }),
  });
  await waitFor(() => expect(server.detailReads(payOrderId).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(main().textContent).toContain(outTradeNo));
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
/** Types `value` into a text input (focus, change, blur). */
export async function fill(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
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
export function moneyText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[,，¥￥]/g, '')
    .replace(/[−–—]/g, '-')
    .replace(/-\s+/g, '-')
    .replace(/\s+/g, ' ');
}
/** `text` shows the yuan amount `yuan` (hand-computed from fen, two decimals). */
export function showsYuan(text: string | null | undefined, yuan: string): boolean {
  return new RegExp(`(?<![\\d.-])${escape(yuan)}(?!\\d)`).test(moneyText(text));
}
/**
 * The amounts `root` shows right after 「可退」 in any of its wordings (「可退 82.50」,
 * 「可退金额：82.50」, 「可退款 82.50」, 「可退款金额（元）：82.50」, 「最多可退 ¥82.50」,
 * 「剩余可退回 82.50 元」); empty when it shows none.
 */
export function refundableShown(root: HTMLElement): string[] {
  const text = moneyText(textOf(root));
  return Array.from(
    text.matchAll(
      /可退(?:款|回)?(?:金额|余额|额度)?\s*(?:[(（]元[)）])?\s*[:：]?\s*(?:为|是)?\s*(-?\d+(?:\.\d+)?)/g,
    ),
    (match) => match[1]!,
  );
}

// ---- rows ----------------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text holds the whole word `word`. */
export function rowsOf(root: ParentNode, word: string): HTMLElement[] {
  const pattern = token(word);
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) =>
    pattern.test(textOf(node)),
  );
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}

// ---- tabs ----------------------------------------------------------------------------------

function tabs(name: RegExp): HTMLElement[] {
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
/** Opens the 「异常收款」 tab and waits for the row of `tradeNo`. */
export async function openAnomalies(tradeNo: string): Promise<HTMLElement> {
  await waitFor(() => expect(tabs(TAB.anomalies).length, 'tab 异常收款').toBeGreaterThan(0));
  await click(tabs(TAB.anomalies)[0]!);
  await settle();
  await waitFor(() => expect(rowsOf(main(), tradeNo), `row ${tradeNo}`).toHaveLength(1));
  return rowsOf(main(), tradeNo)[0]!;
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
/** Presses every control named like a write of this part in `root` (disabled ones do nothing). */
export async function pressWrites(root: HTMLElement): Promise<void> {
  for (const node of actions(root, WRITE_ENTRY)) {
    await click(node);
    await settle();
  }
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
const TITLES = '.ant-modal-title, .ant-drawer-title, .ant-modal-confirm-title';

/** Title of a dialog (aria-labelledby looked up inside first, aria-label, antd titles). */
export function titleOf(node: HTMLElement): string {
  const ids = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  // Under NODE_ENV=test every antd Modal title gets the same id: look inside first.
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
  return openDialogs().filter((node) => STEP_UP_TITLE.test(titleOf(node)));
}
export function stepUpOpen(): boolean {
  return stepUpDialogs().length > 0;
}
/** Waits for the one open step-up dialog. */
export async function stepUpDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(stepUpDialogs(), 'one step-up dialog').toHaveLength(1));
  return stepUpDialogs()[0]!;
}
/** Enters the dynamic code and presses 【验证并继续】. */
export async function verify(modal: HTMLElement): Promise<void> {
  const input = within(modal).getByLabelText('动态码', { exact: true });
  await act(async () => {
    fireEvent.change(input, { target: { value: TOTP_CODE } });
  });
  await click(within(modal).getByRole('button', { name: '验证并继续' }));
  await settle();
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
/** The reason control of the dialog: a select, or a radio group, labelled 原因. */
export function reasonControl(root: HTMLElement): HTMLElement {
  const combos = within(root).queryAllByRole('combobox', { name: LABEL.reason });
  if (combos.length > 0) {
    expect(combos, 'one reason select').toHaveLength(1);
    return combos[0]!;
  }
  const groups = within(root).queryAllByRole('radiogroup', { name: LABEL.reason });
  expect(groups, 'a reason select or radio group').toHaveLength(1);
  return groups[0]!;
}
/**
 * Chooses `option` in the reason select (antd Select or native) or radio group of `root`;
 * returns the texts of every option offered.
 */
export async function chooseReason(root: HTMLElement, option: RegExp): Promise<string[]> {
  const control = reasonControl(root);
  if (control instanceof HTMLSelectElement) {
    const offered = Array.from(control.options).filter((item) => item.value !== '');
    const target = offered.find((item) => option.test(item.text.trim()));
    expect(target, `reason ${String(option)}`).toBeDefined();
    await act(async () => {
      fireEvent.change(control, { target: { value: target!.value } });
    });
    return offered.map((item) => item.text.trim());
  }
  if (control.getAttribute('role') === 'combobox') {
    await act(async () => {
      fireEvent.mouseDown(control);
    });
    let target: HTMLElement | undefined;
    let offered: string[] = [];
    await waitFor(() => {
      const nodes = optionNodes(control);
      offered = nodes.map((node) => (node.textContent ?? '').trim());
      target = nodes.find((node) => option.test((node.textContent ?? '').trim()));
      expect(target, `reason ${String(option)}`).toBeDefined();
    });
    await click(target!);
    return offered;
  }
  const radios = within(control).queryAllByRole('radio');
  const text = (node: HTMLElement): string =>
    (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? '').trim();
  const target = radios.filter((node) => option.test(text(node)));
  expect(target, `a reason radio ${String(option)}`).toHaveLength(1);
  await click(target[0]!);
  return radios.map(text);
}
/** The option text of `code` as the dictionary names it (the code when it has no row). */
export function reasonOption(code: string): RegExp {
  return namePattern('refundReason', code, true);
}
/** The five reason names the dialog must offer (dictionary names, or the code without a row). */
export function reasonNames(): string[] {
  return REASONS.map((code) => dictNames('refundReason', code)[0] ?? code);
}

// ---- the refund dialog ---------------------------------------------------------------------

/** Open dialogs holding the refund amount field. */
export function refundDialogs(): HTMLElement[] {
  return openDialogs().filter((node) => textFields(node, LABEL.amount).length > 0);
}
/** Waits for the one open refund dialog. */
export async function refundDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(refundDialogs(), 'one refund dialog').toHaveLength(1));
  return refundDialogs()[0]!;
}
/** Usable refund entries of the detail page. */
export function refundEntries(): HTMLElement[] {
  return usable(main(), REFUND_ENTRY);
}
/** Usable 【立即查询】 entries of the detail page. */
export function resolveEntries(): HTMLElement[] {
  return usable(main(), RESOLVE_ENTRY);
}
/** Opens the refund dialog from the detail page's 【发起退款】. */
export async function openRefund(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(refundEntries().length, 'a usable 【发起退款】 on the detail').toBeGreaterThan(0),
  );
  await click(refundEntries()[0]!);
  return refundDialog();
}
/** Opens a row's detail (drawer or dialog), when the row has one. */
const ROW_DETAIL = /^(?:详情|查看|查看详情)$/;
/**
 * Usable 【退款】 entries of the anomaly row `row`: in the row itself, or in the detail the row
 * opens (opened here when the row has one).
 */
export async function anomalyRefundEntries(row: HTMLElement): Promise<HTMLElement[]> {
  const inRow = usable(row, REFUND_ENTRY);
  if (inRow.length > 0) return inRow;
  const openers = usable(row, ROW_DETAIL);
  if (openers.length === 0) return [];
  await click(openers[0]!);
  await settle();
  return openDialogs()
    .filter((node) => refundDialogs().indexOf(node) < 0)
    .flatMap((node) => usable(node, REFUND_ENTRY));
}
/** Opens the refund dialog of the anomaly row `row` (its 【退款】, in the row or its detail). */
export async function openAnomalyRefund(row: HTMLElement): Promise<HTMLElement> {
  // The row is on screen already (openAnomalies waited for it), so its entries are too.
  const entries = await anomalyRefundEntries(row);
  expect(entries.length, 'a usable 【退款】 on the anomaly').toBeGreaterThan(0);
  await click(entries[0]!);
  return refundDialog();
}
/**
 * Opens a new refund dialog of the anomaly `tradeNo` once the earlier one is closed: the 【退款】
 * of a row detail still open, or else of the row (looked up again, the list may have been re-read).
 */
export async function reopenAnomalyRefund(tradeNo: string): Promise<HTMLElement> {
  await waitFor(() => expect(refundDialogs()).toEqual([]));
  const inDetail = openDialogs().flatMap((node) => usable(node, REFUND_ENTRY));
  if (inDetail.length > 0) {
    await click(inDetail[0]!);
    return refundDialog();
  }
  await waitFor(() => expect(rowsOf(main(), tradeNo), `row ${tradeNo}`).toHaveLength(1));
  return openAnomalyRefund(rowsOf(main(), tradeNo)[0]!);
}

export interface RefundInput {
  readonly amount?: string;
  readonly reason?: string;
  readonly note?: string;
}
/** Fills the refund dialog: amount (yuan), the reason by its code, the note. */
export async function fillRefund(modal: HTMLElement, input: RefundInput): Promise<void> {
  if (input.amount !== undefined) await fill(textbox(modal, LABEL.amount), input.amount);
  if (input.reason !== undefined) await chooseReason(modal, reasonOption(input.reason));
  if (input.note !== undefined) await fill(textbox(modal, LABEL.note), input.note);
  await settle();
}
/** Buttons that close a dialog without submitting it. */
const DISMISS = /^(?:取消|关闭|知道了|完成|close)$/i;
/** Closes every open refund dialog with its cancel / close button and waits until none is left. */
export async function dismissRefundDialogs(): Promise<void> {
  for (const modal of refundDialogs()) {
    const buttons = actions(modal, DISMISS);
    expect(buttons.length, 'a cancel / close button on the refund dialog').toBeGreaterThan(0);
    await click(buttons[0]!);
    await settle();
  }
  await waitFor(() => expect(refundDialogs()).toEqual([]));
}
/** Presses the submit button of the refund dialog. */
export async function submitRefund(modal: HTMLElement): Promise<void> {
  await click(action(modal, SUBMIT));
  await settle();
}

// ---- 【立即查询】 ----------------------------------------------------------------------------

/**
 * Presses 【立即查询】 and returns the step-up dialog that follows (a confirmation in between is
 * accepted and confirmed).
 */
export async function startResolve(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(resolveEntries().length, 'a usable 【立即查询】 on the detail').toBeGreaterThan(0),
  );
  await click(resolveEntries()[0]!);
  await settle();
  await waitFor(() =>
    expect(openDialogs().length, 'a dialog after 【立即查询】').toBeGreaterThan(0),
  );
  if (!stepUpOpen()) {
    const confirmation = openDialogs().at(-1)!;
    await click(action(confirmation, /^(?:确认|确定|继续|立即查询|查询)/));
    await settle();
  }
  return stepUpDialog();
}

// ---- text that appeared after an action ----------------------------------------------------

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
/** Text the operator is told in: a notice, or a dialog. */
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"]') !== null) return true;
  return element.closest(NOTICES) !== null;
}
/**
 * Text that is new (or changed) since `before`, in notices and in dialogs; standing text that
 * was on the page before the action does not count.
 */
export function freshText(before: TextSnapshot): string {
  return squash(
    textNodes()
      .filter((node) => before.get(node) !== node.data && inReply(node))
      .map((node) => node.data)
      .join(''),
  );
}

// ---- requests ------------------------------------------------------------------------------

/** The Idempotency-Key header of a request (null when missing). */
export function requestKey(request: RequestLog): string | null {
  return request.headers.get('Idempotency-Key');
}
/**
 * A refund request: bearer token, a non-empty Idempotency-Key, no step-up value, and a body of
 * exactly `amount_fen`, `reason_code` and (only when given) `note`.
 */
export function assertRefund(
  request: RequestLog,
  amountFen: number,
  reason: string,
  note?: string,
): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  const value = requestKey(request);
  expect(value, 'an Idempotency-Key header').not.toBeNull();
  expect(value!.trim(), 'a non-empty Idempotency-Key').not.toBe('');
  expect(request.headers.has('X-Step-Up-Token'), 'no step-up value on a refund').toBe(false);
  const body = request.body as Record<string, unknown> | undefined;
  expect(body, 'a JSON body').toBeDefined();
  expect(Object.keys(body!).sort()).toEqual(
    note === undefined ? ['amount_fen', 'reason_code'] : ['amount_fen', 'note', 'reason_code'],
  );
  expect(body!['amount_fen'], 'amount_fen in integer fen').toBe(amountFen);
  expect(body!['reason_code']).toBe(reason);
  if (note !== undefined) {
    expect(typeof body!['note']).toBe('string');
    expect((body!['note'] as string).trim()).toBe(note.trim());
  }
}
/** A resolve request: the fixed body, the step-up value `issued`, no Idempotency-Key. */
export function assertResolve(request: RequestLog, issued: string): void {
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe(issued);
  expect(request.headers.has('Idempotency-Key'), 'no Idempotency-Key on resolve').toBe(false);
  expect(request.body).toEqual({ expected_status: 'PENDING', action: 'query_and_settle' });
}
/** Every verification sent was the dynamic code (totp), `count` of them. */
export function assertVerified(server: Server, count: number): void {
  expect(server.verifies().map((request) => request.body)).toEqual(
    Array.from({ length: count }, () => ({ tier: 'totp', code: TOTP_CODE })),
  );
}
/** No step-up was asked for (no verify request, no step-up dialog). */
export function assertNoStepUp(server: Server): void {
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(stepUpOpen(), 'no step-up dialog').toBe(false);
}
