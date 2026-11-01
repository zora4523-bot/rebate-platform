// F1-07jd jsdom kit. The user detail is reached only through the real admin shell (menu `users`,
// the list's 【详情 <UID>】); no page module is imported, so a missing entry is an assertion
// failure. Every server a test mounts is checked after the test: only the list and detail reads,
// the step-up and the risk-state writes the test declared may have gone out.
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
  RISK_ACTIONS,
  RISK_PATH,
  UID,
  VERIFY,
  CATEGORIES,
  categoryShown,
  hasZone,
  inModeChoice,
  sameMinute,
  type Category,
  type RequestLog,
  type RiskAction,
  type RiskState,
  type Server,
  type WallTime,
} from './risk-fixtures.ts';

// antd's first Modal / Select / DatePicker render of a file (cold CSS-in-JS in jsdom) takes
// seconds on a loaded runner.
configure({ asyncUtilTimeout: 10_000 });
/** Per-test timeout of the multi-step flows (detail → dialog → step-up → write → refresh). */
export const FLOW_TIMEOUT = 90_000;

export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
const READ_POINTS = ['user.list', 'user.lookup'];
const TOTP = { tier: 'totp', operations: {} } as const;
/** risk.freeze only (with the read points), as /me would give it. */
export const FREEZE_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: [...READ_POINTS, 'risk.freeze'],
  stepUp: { 'risk.freeze': TOTP },
};
/** risk.ban only (with the read points). */
export const BAN_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: [...READ_POINTS, 'risk.ban'],
  stepUp: { 'risk.ban': TOTP },
};
/** Every point the detail reads and writes elsewhere, none of risk.*. */
export const NO_RISK: PermissionSnapshot = {
  isSuper: false,
  permissions: [
    ...READ_POINTS,
    'pii.reveal_phone',
    'user.level',
    'user.inviter',
    'union.binding_reset',
    'union.binding_disable',
  ],
  stepUp: {
    'pii.reveal_phone': TOTP,
    'union.binding_reset': TOTP,
    'union.binding_disable': TOTP,
  },
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
  const opener = await waitFor(() => {
    const found = within(main()).queryAllByRole('button', { name: `详情 ${UID}` });
    expect(found, `【详情 ${UID}】 on the list`).toHaveLength(1);
    return found[0]!;
  });
  await click(opener);
  await waitFor(() => expect(main().textContent).toContain(INVITE_CODE));
  await waitFor(() => expect(server.detailReads().length).toBeGreaterThan(0));
  await settled(server);
  header();
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

function visible(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && (node.style.display === 'none' || node.hidden)) return false;
    if (node.classList.contains('ant-drawer') && !node.classList.contains('ant-drawer-open'))
      return false;
    if (node.classList.contains('ant-popover-hidden')) return false;
    if (node.classList.contains('ant-select-dropdown-hidden')) return false;
    if (node.classList.contains('ant-picker-dropdown-hidden')) return false;
  }
  return true;
}

// ---- the title row -------------------------------------------------------------------------

/**
 * The detail's title row: the smallest block around the 用户详情 heading that holds 【返回用户查询】
 * (frozen [AC-F1-07j-*] 口径); it never holds the 基本信息 card.
 */
export function header(): HTMLElement {
  const heading = required(
    within(main()).queryByRole('heading', { name: '用户详情' }),
    '用户详情 heading',
  );
  let found = heading.parentElement;
  while (
    found !== null &&
    found !== main() &&
    within(found).queryByRole('button', { name: '返回用户查询' }) === null
  )
    found = found.parentElement;
  const row = required(found, 'title row with the return action');
  expect(row, 'the title row is not the whole main area').not.toBe(main());
  expect(within(row).queryByText('基本信息', { exact: true }), 'not the 基本信息 card').toBeNull();
  return row;
}
/** Text of the title row without its buttons and links (spaces removed). */
export function headerState(): string {
  const copy = header().cloneNode(true) as HTMLElement;
  const controls = copy.querySelectorAll('button, a, [role="button"], [role="link"]');
  for (const node of Array.from(controls)) node.remove();
  return squash(copy.textContent);
}
/** How the title row's Tag shows a risk state (the console's name or the code). */
export const STATE_SHOWN: Readonly<Record<RiskState, RegExp>> = {
  normal: /正常|(?<![a-z_])normal/,
  frozen: /已冻结|(?<![a-z_])frozen/,
  appealing: /申诉中|(?<![a-z_])appealing/,
  banned: /已封禁|(?<![a-z_])banned/,
};
/** Waits until the title row shows `state` and no other risk state. */
export async function headerShows(state: RiskState): Promise<void> {
  await waitFor(() => {
    const text = headerState();
    expect(text, `the title row shows ${state}`).toMatch(STATE_SHOWN[state]);
    for (const other of Object.keys(STATE_SHOWN) as RiskState[])
      if (other !== state)
        expect(text, `the title row no longer shows ${other}`).not.toMatch(STATE_SHOWN[other]);
  });
}

// ---- entries -------------------------------------------------------------------------------

/** Names of the four entries (spaces removed; antd may put a space between two characters). */
export const ENTRY: Readonly<Record<RiskAction, RegExp>> = {
  freeze: /^冻结$/,
  unfreeze: /^解冻$/,
  ban: /^封禁$/,
  unban: /^解封$/,
};
/** Any of the four. */
export const ANY_ENTRY = /^(?:冻结|解冻|封禁|解封)$/;

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
/** The usable risk entries of the title row, in RISK_ACTIONS order. */
export function entriesOf(): RiskAction[] {
  const row = header();
  return RISK_ACTIONS.filter((action) => usable(row, ENTRY[action]).length > 0);
}
/**
 * Waits until the title row offers exactly `wanted` (usable) and the main area has no other of
 * the four entries, usable or not; an `optional` entry may be there or not.
 */
export async function expectEntries(
  wanted: readonly RiskAction[],
  optional: readonly RiskAction[] = [],
): Promise<void> {
  await waitFor(() => {
    const row = header();
    expect(
      RISK_ACTIONS.filter(
        (action) => !optional.includes(action) && usable(row, ENTRY[action]).length > 0,
      ),
      'usable risk entries of the title row',
    ).toEqual(RISK_ACTIONS.filter((action) => wanted.includes(action)));
    for (const action of wanted)
      expect(actions(main(), ENTRY[action]), `one ${action} entry`).toHaveLength(1);
    for (const action of RISK_ACTIONS)
      if (!wanted.includes(action) && !optional.includes(action))
        expect(actions(main(), ENTRY[action]).map(nameOf), `no ${action} entry at all`).toEqual([]);
  });
}
/** Waits for exactly one usable `action` entry in the title row. */
export async function entry(action: RiskAction): Promise<HTMLElement> {
  await waitFor(() =>
    expect(usable(header(), ENTRY[action]), `one usable ${action} in the title row`).toHaveLength(
      1,
    ),
  );
  return usable(header(), ENTRY[action])[0]!;
}
/** Presses every risk entry of the main area that is disabled (it must do nothing). */
export async function pressDisabled(): Promise<void> {
  for (const node of actions(main(), ANY_ENTRY).filter(isDisabled)) {
    await click(node);
    await settle();
  }
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
/** Open layers other than the step-up dialog, outside the main area (confirmation dialogs). */
export function confirmations(): HTMLElement[] {
  return openLayers().filter((node) => !isStepUp(node) && node.closest('main') === null);
}
/** Waits for the one confirmation dialog (looked up afresh: it may have been re-rendered). */
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
/** Opens the dialog of `action` from the title row. */
export async function openDialog(action: RiskAction): Promise<HTMLElement> {
  return open(await entry(action));
}
/** Controls inside a field (choices, pickers, selects) are never the dialog's submit. */
const FIELD_PARTS =
  '.ant-modal-close, .ant-select, .ant-radio-group, .ant-radio-wrapper, .ant-segmented, .ant-picker, .ant-picker-dropdown, [role="radiogroup"], label';
/**
 * The submit button of a confirmation dialog: its one button that does not dismiss it (the
 * 处理方式 冻结 / 封禁 choices of a dialog that does both are field controls too).
 */
export function submitOf(layer: HTMLElement): HTMLElement {
  const buttons = Array.from(layer.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(
    (node) =>
      node.closest(FIELD_PARTS) === null &&
      !inModeChoice(layer, node) &&
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

// ---- dialog fields -------------------------------------------------------------------------

function isTextField(node: HTMLElement): node is HTMLInputElement | HTMLTextAreaElement {
  return (
    (node instanceof HTMLInputElement &&
      !['file', 'radio', 'checkbox', 'hidden'].includes(node.type) &&
      node.getAttribute('role') !== 'combobox') ||
    node instanceof HTMLTextAreaElement
  );
}
/** Text inputs of `layer` labelled (or with a placeholder) like `pattern`. */
function textFields(layer: HTMLElement, label: RegExp, placeholder: RegExp) {
  const labelled = within(layer).queryAllByLabelText(label);
  const placeholders = within(layer).queryAllByPlaceholderText(placeholder);
  return [...new Set([...labelled, ...placeholders])].filter(isTextField);
}
/** The one text input labelled (or with a placeholder) 原因 in `layer`. */
export function reasonField(layer: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const found = textFields(layer, /原因/, /原因/);
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

/** The text a radio goes by (its label or aria-label, spaces removed). */
function labelOf(node: HTMLElement): string {
  return squash(node.closest('label')?.textContent ?? node.getAttribute('aria-label'));
}
function radiosOf(layer: HTMLElement): HTMLElement[] {
  return within(layer).queryAllByRole('radio');
}
/** The radios of `layer` that name a reason category. */
export function categoryRadios(layer: HTMLElement): HTMLElement[] {
  return radiosOf(layer).filter((node) =>
    CATEGORIES.some((code) => categoryShown(code).test(labelOf(node))),
  );
}
/** Selects of `layer` (antd Select or native); the category choice when there are no radios. */
export function selectsOf(layer: HTMLElement): HTMLElement[] {
  return within(layer).queryAllByRole('combobox');
}

function optionNodes(combo: HTMLElement): HTMLElement[] {
  const id = combo.getAttribute('aria-controls') ?? combo.getAttribute('aria-owns');
  const list = id === null || id === '' ? null : document.getElementById(id);
  const own = list?.closest<HTMLElement>('.ant-select-dropdown') ?? null;
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

/** The reason categories the open dialog offers (radios, or the options of its one select). */
export async function offeredCategories(): Promise<Category[]> {
  const layer = await confirmation();
  const radios = categoryRadios(layer);
  if (radios.length > 0)
    return CATEGORIES.filter((code) =>
      radios.some((node) => categoryShown(code).test(labelOf(node))),
    );
  const combos = selectsOf(layer);
  expect(combos, 'a reason category choice (radios or one select)').toHaveLength(1);
  const combo = combos[0]!;
  if (combo instanceof HTMLSelectElement)
    return CATEGORIES.filter((code) =>
      Array.from(combo.options).some((item) => categoryShown(code).test(item.text)),
    );
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  const offered = await waitFor(() => {
    const texts = optionNodes(combo).map((node) => squash(node.textContent));
    expect(texts.length, 'the category select lists its options').toBeGreaterThan(0);
    return texts;
  });
  await act(async () => {
    fireEvent.keyDown(combo, { key: 'Escape', code: 'Escape' });
  });
  return CATEGORIES.filter((code) => offered.some((text) => categoryShown(code).test(text)));
}

/** Chooses the reason category `code` (a radio, or the one select of the dialog). */
export async function chooseCategory(code: Category): Promise<void> {
  const layer = await confirmation();
  const pattern = categoryShown(code);
  const radios = categoryRadios(layer);
  if (radios.length > 0) {
    const target = radios.filter((node) => pattern.test(labelOf(node)));
    expect(target, `one radio for the category ${code}`).toHaveLength(1);
    if (!(target[0] as HTMLInputElement).checked) await click(target[0]!);
    return;
  }
  const combos = selectsOf(layer);
  expect(combos, 'a reason category choice (radios or one select)').toHaveLength(1);
  const combo = combos[0]!;
  if (combo instanceof HTMLSelectElement) {
    const option = Array.from(combo.options).find((item) => pattern.test(item.text));
    expect(option, `option ${code}`).toBeDefined();
    await act(async () => {
      fireEvent.change(combo, { target: { value: option!.value } });
    });
    return;
  }
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  const target = await waitFor(() => {
    const found = optionNodes(combo).find((node) => pattern.test(squash(node.textContent)));
    expect(found, `option ${code} of the category select`).toBeDefined();
    return found!;
  });
  await click(target);
}

/** A choice of a freeze without end (the board: 「不设期限（人工解冻）」). */
export const PERIOD_NONE = /不设期限|不定期|无期限|不限期|永久|长期|人工解冻|手动解冻/;
/** A choice of a freeze that ends by itself (the board: 「到期自动解冻」). */
export const PERIOD_UNTIL = /到期|定期|设定期限|设置期限|指定|自动解冻|截止|限期/;
/**
 * The radios of `layer` that choose the freeze period. The 处理方式 choices of a dialog that does
 * both are not among them (the board's 封禁 choice reads 「…不设期限」).
 */
export function periodRadios(layer: HTMLElement): HTMLElement[] {
  return radiosOf(layer).filter((node) => {
    if (inModeChoice(layer, node)) return false;
    const label = labelOf(node);
    return PERIOD_NONE.test(label) || PERIOD_UNTIL.test(label);
  });
}
/** Date-time inputs of `layer` (labelled or with a placeholder like a time; not the reason). */
export function timeFields(layer: HTMLElement): HTMLInputElement[] {
  const reasons = new Set<HTMLElement>(textFields(layer, /原因/, /原因/));
  return textFields(
    layer,
    /期限|到期|截止|结束|解冻时间|时间|日期/,
    /期限|到期|截止|结束|时间|日期|YYYY/i,
  ).filter(
    (node): node is HTMLInputElement => node instanceof HTMLInputElement && !reasons.has(node),
  );
}
/** The one date-time input of the open dialog. */
export async function timeField(): Promise<HTMLInputElement> {
  const found = timeFields(await confirmation());
  expect(found, 'one freeze end input in the dialog').toHaveLength(1);
  return found[0]!;
}
function digits(text: string): string {
  return text.replace(/\D/g, '');
}
/**
 * Enters the Beijing wall-clock time `wall` into the freeze end: a native datetime-local input,
 * or an antd date-time picker (typed in one of the usual formats, Enter and the picker's OK).
 * Returns whether the field took it (a picker may refuse a time that has passed).
 */
export async function tryTime(wall: WallTime): Promise<boolean> {
  const first = await timeField();
  if (first.type === 'datetime-local') {
    await fill(first, `${wall.date}T${wall.time}`);
    return digits((await timeField()).value).startsWith(digits(`${wall.date}${wall.time}`));
  }
  const wanted = digits(`${wall.date}${wall.time}`);
  const slash = wall.date.replace(/-/g, '/');
  const formats = [
    `${wall.date} ${wall.time}:00`,
    `${wall.date} ${wall.time}`,
    `${slash} ${wall.time}`,
    `${wall.date}T${wall.time}`,
  ];
  for (const text of formats) {
    const input = await timeField();
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
    await settle();
    if (digits((await timeField()).value).startsWith(wanted)) return true;
  }
  return false;
}
/** Enters `wall` and checks that the field took it. */
export async function enterTime(wall: WallTime): Promise<void> {
  const taken = await tryTime(wall);
  expect(taken, `the freeze end takes ${wall.date} ${wall.time}`).toBe(true);
}
/** Chooses a freeze without end, or one until `period`. */
export async function choosePeriod(period: 'none' | WallTime): Promise<void> {
  const layer = await confirmation();
  const radios = periodRadios(layer);
  if (period === 'none') {
    const none = radios.filter((node) => PERIOD_NONE.test(labelOf(node)));
    if (none.length > 0) {
      expect(none, 'one choice of a freeze without end').toHaveLength(1);
      if (!(none[0] as HTMLInputElement).checked) await click(none[0]!);
      return;
    }
    // No choice offered: an empty end means without end.
    for (const input of timeFields(layer)) if (input.value !== '') await fill(input, '');
    return;
  }
  const until = radios.filter(
    (node) => PERIOD_UNTIL.test(labelOf(node)) && !PERIOD_NONE.test(labelOf(node)),
  );
  if (until.length > 0) {
    expect(until, 'one choice of a freeze with an end').toHaveLength(1);
    if (!(until[0] as HTMLInputElement).checked) await click(until[0]!);
  }
  await enterTime(period);
}

/** What the operator fills in: category (freeze, ban), period (freeze) and reason. */
export interface RiskForm {
  readonly category?: Category;
  readonly period?: 'none' | WallTime;
  readonly reason: string;
}
/** Fills the open dialog with `form`. */
export async function fillForm(form: RiskForm): Promise<void> {
  if (form.category !== undefined) await chooseCategory(form.category);
  if (form.period !== undefined) await choosePeriod(form.period);
  await fill(reasonField(await confirmation()), form.reason);
}

export interface Performed {
  /** The write request. */
  readonly write: RequestLog;
  /** The page's text just before the dialog was submitted. */
  readonly prior: Before;
}
/**
 * Opens `action` from the title row, fills `form`, submits (twice when `twice`), checks that
 * nothing was written before the step-up, verifies and waits for the write and its answer.
 */
export async function perform(
  server: Server,
  action: RiskAction,
  form: RiskForm,
  twice = false,
): Promise<Performed> {
  await openDialog(action);
  await fillForm(form);
  const layer = await confirmation();
  const writes = server.writes().length;
  const submit = submitOf(layer);
  const prior = before();
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
  await stepUp();
  expect(server.writes().length, `no ${action} before the step-up`).toBe(writes);
  await verify(server, twice);
  await waitFor(() => expect(server.writes().length).toBe(writes + 1));
  await settled(server);
  return { write: server.writes().at(-1)!, prior };
}

// ---- requests ------------------------------------------------------------------------------

/** The step-up grant a request carried. */
export function passOf(request: { readonly headers: Headers }): string | null {
  return request.headers.get('X-Step-Up-Token');
}
/** The write is one PUT …/risk-state with a fresh grant, after a step-up, no Idempotency-Key. */
export function expectWrite(server: Server, write: RequestLog): void {
  expect(write.method).toBe('PUT');
  expect(write.path).toBe(RISK_PATH);
  expect(write.query).toEqual({});
  expect(write.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
  expect(passOf(write), 'X-Step-Up-Token').not.toBeNull();
  expect(server.issued).toContain(passOf(write));
  const sent = server.log.indexOf(write);
  const verified = server.log.findIndex((one) => one.method === 'POST' && one.path === VERIFY);
  expect(verified, 'a step-up before the write').toBeGreaterThanOrEqual(0);
  expect(sent).toBeGreaterThan(verified);
}
/**
 * The body is `wanted` exactly, apart from frozen_until: absent (`until` undefined), null or
 * absent (`'none'`), or the minute `until` as an ISO time with a zone.
 */
export function expectBody(
  write: RequestLog,
  wanted: Readonly<Record<string, unknown>>,
  until?: 'none' | WallTime,
): void {
  const body = write.body;
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'a JSON object').toBe(
    true,
  );
  const { frozen_until: end, ...rest } = body as Record<string, unknown>;
  expect(rest).toStrictEqual(wanted);
  expect(Object.hasOwn(rest, 'expected_row_version'), 'expected_row_version is sent').toBe(true);
  if (until === undefined)
    expect(Object.hasOwn(body as object, 'frozen_until'), 'no frozen_until').toBe(false);
  else if (until === 'none') expect(end ?? null, 'a freeze without end').toBeNull();
  else {
    expect(hasZone(end), `frozen_until ${String(end)} is ISO with a zone`).toBe(true);
    expect(sameMinute(end, until), `frozen_until ${String(end)} is the chosen minute`).toBe(true);
  }
}
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
/** Visible text nodes whose text was not on the page before (a re-rendered label is not new). */
function freshNodes(prior: Before): Text[] {
  return textNodes().filter(
    (node) =>
      shown(node) && prior.nodes.get(node) !== node.data && !prior.strings.has(node.data.trim()),
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
/** New text in notices outside any dialog (messages, notifications, alerts of the page). */
export function noticeText(prior: Before): string {
  return join(
    freshNodes(prior).filter((node) => {
      const element = node.parentElement!;
      return element.closest(NOTICES) !== null && element.closest(LAYERS) === null;
    }),
  );
}
/** A new notice or dialog text says `pattern`. */
export async function announce(prior: Before, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(freshText(prior), `a notice ${String(pattern)}`).toMatch(pattern));
}

/** Success notices of the four actions (each tells which one went through). */
export const SUCCESS: Readonly<Record<RiskAction, RegExp>> = {
  freeze: /(?<!解除)冻结.{0,12}(?:成功|完成)|成功冻结/,
  unfreeze: /(?:解冻|解除冻结).{0,12}(?:成功|完成)|成功(?:解冻|解除冻结)/,
  ban: /(?<!解除)封禁.{0,12}(?:成功|完成)|成功封禁/,
  unban: /(?:解封|解除封禁).{0,12}(?:成功|完成)|成功(?:解封|解除封禁)/,
};
/** A new notice tells that `action` went through, and names none of the other three. */
export async function announceSuccess(prior: Before, action: RiskAction): Promise<void> {
  await waitFor(() => {
    const text = freshText(prior);
    expect(text, `a ${action} success notice`).toMatch(SUCCESS[action]);
    for (const other of RISK_ACTIONS)
      if (other !== action)
        expect(text, `the notice is not a ${other} success`).not.toMatch(SUCCESS[other]);
  });
}
/** No new notice says any of the four went through. */
export function expectNoSuccess(prior: Before): void {
  const text = noticeText(prior);
  for (const action of RISK_ACTIONS)
    expect(text, `no ${action} success notice`).not.toMatch(SUCCESS[action]);
}

/** What the operator is told after a refused or failed write (only new text counts). */
export const HINT = {
  changed: /状态已变化|已变化|已变更|已被.{0,10}(?:修改|处理|操作|更新)|请刷新|已刷新/,
  notAllowed:
    /不允许|(?:不能|无法|不可|不支持).{0,10}(?:此|这项|该|这个)?操作|状态.{0,10}(?:不能|无法|不可)/,
  refreshFailed: /未能刷新|刷新失败|无法刷新|没能刷新|未刷新|没有刷新|刷新.{0,6}(?:失败|出错|异常)/,
  forbidden: /权限/,
  failed: /网络|失败|异常|稍后/,
  /** States the reason rule (a bare 「4 / 200」 counter, 「原因」 or 「参数错误」 does not). */
  reason:
    /必填|不能为空|不可为空|不得为空|请填写|请输入|\d+\s*个?字|不超过|不能超过|超过|超出|最多|至多|过长|太长/,
  /** About the freeze end. */
  time: /期限|到期|截止|时间|日期|晚于|之后|早于|过去|已过|未来/,
  /** About the missing reason category. */
  category: /类别|请选择|必选/,
} as const;
/** The reason rule stated in a dialog whose submit is held disabled (a counter alone does not). */
export const REASON_RULE =
  /必填|不能为空|不可为空|不得为空|请填写|\d+\s*个?字|不超过|不能超过|最多|至多/;

/**
 * The visible text of `root` without counters (labels and static help included); with
 * `withoutModes`, the 处理方式 冻结 / 封禁 choices of a dialog that does both are left out too.
 */
export function ruleText(root: HTMLElement, withoutModes = false): string {
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element === null || !visible(element)) continue;
    if (element.closest(`textarea, ${COUNTERS}`) !== null) continue;
    if (withoutModes && inModeChoice(root, node)) continue;
    parts.push((node as Text).data);
  }
  return squash(parts.join('')).replace(/\d+[/／]\d+/g, '');
}

/** Hint areas of a field: its form item, its described-by / error targets, the dialog's alerts. */
function besideField(layer: HTMLElement, field: HTMLElement | undefined): HTMLElement[] {
  const areas = Array.from(
    layer.querySelectorAll<HTMLElement>(
      '[role="alert"], .ant-form-item-explain, .ant-form-item-extra, .ant-alert',
    ),
  );
  if (field === undefined) return areas;
  const item = field.closest<HTMLElement>('.ant-form-item');
  if (item !== null) areas.push(item);
  for (const name of ['aria-describedby', 'aria-errormessage'])
    for (const id of (field.getAttribute(name) ?? '').split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(id);
      if (target !== null) areas.push(target);
    }
  return areas;
}
function hintIn(prior: Before, areas: readonly HTMLElement[]): string {
  return join(
    freshNodes(prior).filter(
      (node) =>
        node.parentElement!.closest('label, .ant-form-item-label') === null &&
        areas.some((area) => area.contains(node)),
    ),
  );
}
/**
 * New hint text beside the reason input of the open dialog (counters and labels left out). With
 * `orNotice` (nothing was sent) a new alert, message or notification anywhere counts too.
 */
export function reasonHint(prior: Before, orNotice: boolean): string {
  const layers = confirmations();
  const areas: HTMLElement[] =
    layers.length === 1 ? besideField(layers[0]!, reasonField(layers[0]!)) : [];
  if (orNotice) areas.push(...Array.from(document.querySelectorAll<HTMLElement>(NOTICES)));
  return hintIn(prior, areas);
}
/** New hint text beside the freeze end of the open dialog (or, with `orNotice`, any notice). */
export function timeHint(prior: Before, orNotice: boolean): string {
  const layers = confirmations();
  const layer = layers.length === 1 ? layers[0]! : undefined;
  const areas: HTMLElement[] = [];
  if (layer !== undefined) {
    const fields = timeFields(layer);
    areas.push(...besideField(layer, fields[0]));
    for (const radio of periodRadios(layer)) {
      const item = radio.closest<HTMLElement>('.ant-form-item');
      if (item !== null) areas.push(item);
    }
  }
  if (orNotice) areas.push(...Array.from(document.querySelectorAll<HTMLElement>(NOTICES)));
  return hintIn(prior, areas);
}
/** New hint text in the open dialog or (with `orNotice`) any notice: for the category. */
export function dialogHint(prior: Before, orNotice: boolean): string {
  const layers = confirmations();
  const areas: HTMLElement[] = layers.length === 1 ? [layers[0]!] : [];
  if (orNotice) areas.push(...Array.from(document.querySelectorAll<HTMLElement>(NOTICES)));
  return hintIn(prior, areas);
}
