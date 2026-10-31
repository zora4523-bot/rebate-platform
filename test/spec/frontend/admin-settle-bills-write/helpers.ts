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
  OTP,
  billOf,
  billPath,
  namePattern,
  snapshot as snapshotOf,
  type DictField,
  type RequestLog,
  type Server,
  type WriteOp,
} from './fixtures.ts';

// The page is reached only through the real shell (createAdminShell, menu id `settle-bills` or the
// detail address settle-bills/{bill_id}); no page module is imported, so a missing entry is an
// assertion failure. Every server a test mounts is checked after the test: only the three reads,
// the step-up and the writes the test declared may have gone out.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (detail → dialog → step-up → write → refresh). */
export const FLOW_TIMEOUT = 90_000;

const mounted: Server[] = [];
afterEach(() => {
  const servers = mounted.splice(0);
  cleanup();
  vi.unstubAllGlobals();
  for (const server of servers)
    expect(server.strays(), 'requests outside the three reads, step-up and allowed writes').toEqual(
      [],
    );
});

// ---- names ---------------------------------------------------------------------------------

/** The write entries of the page (spaces removed). */
export const ENTRY = {
  confirmNow: /^(?:确认立即执行|立即执行)$/,
  schedule: /^定时执行$/,
  reject: /^驳回$/,
  cancelSchedule: /^撤销定时$/,
  resume: /^继续执行$/,
  supplement: /^(?:发起补充批次|生成补充批次)$/,
} as const;
/** Any write entry of this page. */
export const WRITE_ENTRY =
  /^(?:确认立即执行|立即执行|定时执行|确认结算|撤销定时|驳回|继续执行|发起补充批次|生成补充批次)$/;
/** The entry of a batch's items (F1-08d). */
export const ITEMS_ENTRY = /^(?:明细|查看明细|批次明细)$/;
/** The row entry of a bill on the list (F1-08d). */
export const VIEW_ENTRY = /^(?:查看|详情|查看详情)$/;
/** The title of the step-up dialog (apps/admin StepUpModal, totp tier). */
export const STEP_UP_TITLE = /二次验证|动态码/;
const VERIFY_BUTTON = /^验证并继续$/;
const DISMISS = /^(?:取消|关闭|返回|Close|Cancel)$/i;

/** Texts the operator is told after an operation (only text new since the operation counts). */
export const HINT = {
  success: /成功|已(?:确认|提交|撤销|驳回|恢复|继续|生成|发起|开始)/,
  changed: /状态已变化|已变化|已变更|已被.{0,10}(?:修改|处理|操作|更新|确认|驳回)|请刷新|已刷新/,
  notReady:
    /出账中|生成中|尚未(?:出账|生成|就绪|完成)|未(?:出账|生成|就绪)|还没.{0,4}(?:出账|生成)/,
  nothing:
    /无可纳入|没有可纳入|无.{0,6}可.{0,6}(?:纳入|补充)|没有.{0,8}(?:可|需要).{0,6}(?:纳入|补充)|无需补充|未生成.{0,6}批次|没有生成/,
  reason: /原因/,
  /** A hint by the schedule time (missing, past, inside the snapshot window, refused). */
  timeInvalid:
    /(?:时间|时刻).{0,20}(?:不|无效|须|需|必须|晚于|窗口|重新|错误|有误|已过|早于)|(?:请|须|需|必须|重新).{0,8}(?:时间|时刻)/,
  switches: /开关/,
  snapshot: /快照/,
  pendingDraft: /待确认|先确认|驳回|DRAFT/,
  credit: /开关|入账.{0,6}(?:关闭|未开)/,
  /** The confirmation covers every waiting batch of the bill (BR-FUND-04 ⑥). */
  scope:
    /全部.{0,12}(?:待确认|DRAFT).{0,4}批次|(?:待确认|DRAFT).{0,6}批次.{0,12}(?:全部|一并|一次|都)|一次.{0,6}确认.{0,12}全部/,
} as const;

// ---- mounting ------------------------------------------------------------------------------

export interface MountOptions {
  /** Defaults to the server's own permission points (settle.bill carries the totp tier). */
  readonly snapshot?: PermissionSnapshot;
  /** The address without its leading slash; defaults to the list (settle-bills). */
  readonly route?: string;
}

/** Mounts the real admin shell on 资金 / 月结账单 (or a detail address) over the fake server. */
export async function mount(server: Server, options: MountOptions = {}) {
  installMediaQuery();
  mounted.push(server);
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

/** Mounts the detail address of `billId` and waits for its read and every batch row. */
export async function openDetail(
  server: Server,
  billId: string,
  snapshot?: PermissionSnapshot,
): Promise<void> {
  await mount(server, {
    route: `settle-bills/${billId}`,
    ...(snapshot === undefined ? {} : { snapshot }),
  });
  await shown(server, billId);
}

/** Waits for the read of `billId` and for one row per batch of the server's state. */
export async function shown(server: Server, billId: string): Promise<void> {
  await waitFor(() => expect(server.billReads(billId).length).toBeGreaterThan(0));
  await settled(server);
  for (const one of billOf(server, billId).batches)
    await waitFor(() =>
      expect(batchRows(one.batch_id), `batch row ${one.batch_id.slice(0, 8)}`).toHaveLength(1),
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

// ---- text ----------------------------------------------------------------------------------

/** NodeFilter.SHOW_TEXT (spelled out so no environment global is needed). */
const SHOW_TEXT = 0x4;

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** An id as shown: its first 8 characters as a token (the page may shorten long ids). */
export function idToken(id: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(id.slice(0, 8))}(?![A-Za-z0-9_])`);
}
/** The text nodes of `node` joined with spaces. */
export function textOf(node: Node): string {
  const walker = document.createTreeWalker(node, SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text !== null; text = walker.nextNode())
    parts.push((text as Text).data);
  return parts.join(' ');
}
/** `text` shows `code` of `field` as the console dictionary has it (or the code itself). */
export function showsName(text: string, field: DictField, code: string): boolean {
  return namePattern(field, code).test(squash(text)) || namePattern(field, code).test(text);
}

export function main(): HTMLElement {
  const found = document.querySelector<HTMLElement>('main');
  expect(found, 'the shell renders its main landmark').not.toBeNull();
  return found!;
}

// ---- rows ----------------------------------------------------------------------------------

const ROW = 'tr, [role="row"], [role="listitem"], li';

/** The innermost rows of `root` whose text matches every pattern. */
export function rowsWith(root: ParentNode, patterns: readonly RegExp[]): HTMLElement[] {
  const matching = Array.from(root.querySelectorAll<HTMLElement>(ROW)).filter((node) => {
    const text = textOf(node);
    return patterns.every((pattern) => pattern.test(text));
  });
  return matching.filter(
    (node) => !matching.some((other) => other !== node && node.contains(other)),
  );
}
/** Rows of the detail's batch table (in the main area) for `batchId`. */
export function batchRows(batchId: string): HTMLElement[] {
  return rowsWith(main(), [idToken(batchId)]);
}
export function batchRow(batchId: string): HTMLElement {
  const found = batchRows(batchId);
  expect(found, `one batch row ${batchId.slice(0, 8)}`).toHaveLength(1);
  return found[0]!;
}
/** Waits until the row of `batchId` shows `code` of `field`. */
export async function rowShows(batchId: string, field: DictField, code: string): Promise<void> {
  await waitFor(() =>
    expect(
      showsName(textOf(batchRow(batchId)), field, code),
      `${batchId.slice(0, 8)} shows ${code}`,
    ).toBe(true),
  );
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
/** Usable (not disabled) actions of `root` named `name`. */
export function usable(root: HTMLElement, name: RegExp): HTMLElement[] {
  return actions(root, name).filter((node) => !isDisabled(node));
}
/** Waits for exactly one usable entry `name` in the main area (the detail's title area). */
export async function pageEntry(name: RegExp): Promise<HTMLElement> {
  await waitFor(() => expect(usable(main(), name), `one usable ${String(name)}`).toHaveLength(1));
  return usable(main(), name)[0]!;
}
/** Waits for exactly one usable entry `name` in the row of `batchId`. */
export async function rowEntry(batchId: string, name: RegExp): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      usable(batchRow(batchId), name),
      `one usable ${String(name)} for ${batchId.slice(0, 8)}`,
    ).toHaveLength(1),
  );
  return usable(batchRow(batchId), name)[0]!;
}
/** Presses every write-named control of the page (a disabled one does nothing). */
export async function pressWrites(): Promise<void> {
  for (const node of actions(document.body, WRITE_ENTRY)) {
    await click(node);
    await settle();
  }
}

// ---- dialogs -------------------------------------------------------------------------------

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (node.classList.contains('ant-popover-hidden')) return false;
  }
  return true;
}
/** Open dialogs and pop-confirms. */
export function openLayers(): HTMLElement[] {
  const found = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], .ant-popconfirm'),
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
/** Open layers other than the step-up dialog and the batch items drawer. */
export function confirmations(): HTMLElement[] {
  return openLayers().filter(
    (node) => !isStepUp(node) && !/批次明细/.test(titleOf(node)) && node.closest('main') === null,
  );
}
/** Waits for the one confirmation dialog an entry opened. */
export async function confirmation(): Promise<HTMLElement> {
  await waitFor(() => expect(confirmations(), 'one confirmation dialog').toHaveLength(1));
  return confirmations()[0]!;
}
/** Presses `entry` and waits for its confirmation dialog. */
export async function open(entry: HTMLElement): Promise<HTMLElement> {
  await click(entry);
  return confirmation();
}
/** The submit button of a confirmation dialog: its one button that does not dismiss it. */
export function submitOf(layer: HTMLElement): HTMLElement {
  const buttons = Array.from(layer.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (node) =>
      node.closest('.ant-modal-close, .ant-picker, .ant-select, .ant-radio-group, label') ===
        null &&
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

/**
 * Presses the submit of `layer` (twice when `twice`: one write only), checks that no write of `op`
 * left before the step-up, verifies and waits for the write.
 */
export async function submitThroughStepUp(
  server: Server,
  layer: HTMLElement,
  op: WriteOp,
  twice = false,
): Promise<void> {
  const writes = server.writes(op).length;
  const submit = submitOf(layer);
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
  await stepUp();
  expect(server.writes(op).length, `no ${op} before the step-up`).toBe(writes);
  await verify(server);
  await waitFor(() => expect(server.writes(op).length).toBe(writes + 1));
  await settled(server);
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
export async function fill(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

/** Chooses the radio named `name` of `root` when there is one and it is not checked yet. */
export async function chooseRadio(root: HTMLElement, name: RegExp): Promise<void> {
  const radios = within(root)
    .queryAllByRole('radio')
    .filter((node) => {
      const label = node.closest('label');
      return name.test(squash(label?.textContent ?? node.getAttribute('aria-label')));
    });
  if (radios.length === 0) return;
  expect(radios, `one radio ${String(name)}`).toHaveLength(1);
  if (!(radios[0] as HTMLInputElement).checked) await click(radios[0]!);
}

/** The schedule time field of the confirmation dialog. */
export function timeField(layer: HTMLElement): HTMLInputElement {
  const labelled = within(layer).queryAllByLabelText(/时间|时刻/);
  const placeholders = within(layer).queryAllByPlaceholderText(/时间|时刻|日期|YYYY/);
  const found = [...new Set([...labelled, ...placeholders])].filter(
    (node): node is HTMLInputElement =>
      node instanceof HTMLInputElement && !['radio', 'checkbox', 'hidden'].includes(node.type),
  );
  expect(found, 'one schedule time input in the dialog').toHaveLength(1);
  return found[0]!;
}
function digits(text: string): string {
  return text.replace(/\D/g, '');
}
/**
 * Enters the wall-clock time `date` `time` (YYYY-MM-DD, HH:mm) into the schedule field: a native
 * datetime-local input, or an antd date-time picker (typed in one of the usual formats, Enter and
 * the picker's OK).
 */
export async function enterTime(layer: HTMLElement, date: string, time: string): Promise<void> {
  const input = timeField(layer);
  if (input.type === 'datetime-local') {
    await fill(input, `${date}T${time}`);
    return;
  }
  const wanted = digits(`${date}${time}`);
  const slash = date.replace(/-/g, '/');
  const formats = [`${date} ${time}:00`, `${date} ${time}`, `${slash} ${time}`, `${date}T${time}`];
  for (const text of formats) {
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.mouseDown(input);
      fireEvent.change(input, { target: { value: text } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });
    const confirmPick = document.querySelector<HTMLElement>(
      '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-ok button:not([disabled])',
    );
    if (confirmPick !== null) await click(confirmPick);
    await act(async () => {
      fireEvent.blur(input);
    });
    if (digits(timeField(layer).value).startsWith(wanted)) return;
  }
  expect(timeField(layer).value, `the schedule field takes ${date} ${time}`).toContain(time);
}
/** `value` is the wall-clock time `date` `time` in Beijing time, or in the machine's own zone. */
export function sameMoment(value: unknown, date: string, time: string): boolean {
  if (typeof value !== 'string') return false;
  const at = Date.parse(value);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const beijing = Date.UTC(year, month - 1, day, hour - 8, minute);
  const local = new Date(year, month - 1, day, hour, minute).getTime();
  return at === beijing || at === local;
}

/** Ticks the platform `code` (radio, checkbox or select option) when the dialog offers a choice. */
export async function choosePlatform(
  layer: HTMLElement,
  code: string,
  name: RegExp,
): Promise<void> {
  const pattern = new RegExp(`${name.source}|(?<![A-Za-z])${code}(?![A-Za-z])`, 'i');
  const ticks = within(layer)
    .queryAllByRole('radio')
    .concat(within(layer).queryAllByRole('checkbox'))
    .filter((node) =>
      pattern.test(squash(node.closest('label')?.textContent ?? node.getAttribute('aria-label'))),
    );
  if (ticks.length > 0) {
    expect(ticks, `one choice for ${code}`).toHaveLength(1);
    if (!(ticks[0] as HTMLInputElement).checked) await click(ticks[0]!);
    return;
  }
  const combos = within(layer).queryAllByRole('combobox');
  if (combos.length === 0) return;
  expect(combos, 'one platform select').toHaveLength(1);
  await act(async () => {
    fireEvent.mouseDown(combos[0]!);
  });
  let target: HTMLElement | undefined;
  await waitFor(() => {
    target = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      ),
    ).find((node) => pattern.test(squash(node.textContent)));
    expect(target, `option ${code}`).toBeDefined();
  });
  await click(target!);
}

// ---- text that appeared after an action ----------------------------------------------------

const NOTICES =
  '[role="alert"], [role="status"], .ant-message-notice, .ant-notification-notice, .ant-alert, .ant-result, .ant-empty, .ant-form-item-explain';

function textNodes(): Text[] {
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}
export interface Before {
  readonly nodes: ReadonlyMap<Text, string>;
  readonly main: string;
}
/** Every text node on the page with its text, and the main area's text, taken before an action. */
export function before(): Before {
  return {
    nodes: new Map(textNodes().map((node): [Text, string] => [node, node.data])),
    main: squash(main().textContent),
  };
}
function inReply(node: Text): boolean {
  const element = node.parentElement;
  if (element === null || element.closest('textarea') !== null || !visible(element)) return false;
  if (element.closest('[role="dialog"], .ant-popconfirm') !== null) return true;
  return element.closest(NOTICES) !== null;
}
/** Text new (or changed) since `prior`, in notices and in dialogs. */
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
/** The operator was told `pattern` after the action (new notice / dialog text, or new in main). */
export function told(prior: Before, pattern: RegExp): boolean {
  if (pattern.test(freshText(prior))) return true;
  return !pattern.test(prior.main) && pattern.test(squash(main().textContent));
}
export async function tell(prior: Before, pattern: RegExp): Promise<void> {
  await waitFor(() =>
    expect(told(prior, pattern), `told ${String(pattern)}: ${freshText(prior)}`).toBe(true),
  );
}
/** A new notice or dialog text says `pattern` (a status cell that changed does not count). */
export async function announce(prior: Before, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(freshText(prior), `a notice ${String(pattern)}`).toMatch(pattern));
}

// ---- requests ------------------------------------------------------------------------------

/** No step-up was asked for (no verify request, no step-up dialog). */
export function assertNoStepUp(server: Server): void {
  expect(server.verifies()).toEqual([]);
  expect(stepUpDialogs(), 'no step-up dialog').toEqual([]);
}
/** Waits for a read of the detail of `billId` sent after `request`. */
export async function readAgain(
  server: Server,
  billId: string,
  request: RequestLog,
): Promise<void> {
  const sent = server.log.indexOf(request);
  expect(sent, 'the request is in the log').toBeGreaterThanOrEqual(0);
  await waitFor(() =>
    expect(
      server.log
        .slice(sent + 1)
        .filter((one) => one.method === 'GET' && one.path === billPath(billId)),
      'the detail is read again',
    ).not.toEqual([]),
  );
  await settled(server);
}
/** The step-up grant a request carried. */
export function passOf(request: { headers: Headers }): string | null {
  return request.headers.get('X-Step-Up-Token');
}
/** Expected batches of a confirm body, sorted by batch_id. */
export function sortedExpected(body: unknown): unknown[] {
  const list = (body as { expected_batches?: unknown } | undefined)?.expected_batches;
  expect(Array.isArray(list), 'expected_batches is a list').toBe(true);
  return (list as { batch_id: string }[])
    .slice()
    .sort((a, b) => (a.batch_id < b.batch_id ? -1 : a.batch_id > b.batch_id ? 1 : 0));
}
