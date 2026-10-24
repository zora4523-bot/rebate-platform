// Shared jsdom harness of F1-10gc: mounts /unions (memory router, the real UnionsPage) with a
// permission snapshot, the permission-checking fake backend of ./server.ts and, when given, the
// shell's planned list (F1-06zu); reads what a dialog's select offers without choosing.
import { createElement } from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { UnionsPage } from '../../../../apps/admin/src/pages/unions/index.ts';
import {
  createAccessControl,
  type PermissionSnapshot,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { ACCOUNTS, BASE_URL, NOW, PHONES } from '../admin-union-pids/fixtures.ts';
import {
  LABEL,
  PERMITTED,
  action,
  click,
  dialogs,
  main,
  openEdit,
  settle,
} from '../admin-union-pids/helpers.ts';
import { backend, type Backend, type BackendOptions } from './server.ts';

export { PERMITTED };
/** Holds union.pid only (no union.account_auth). */
export const PIDS_ONLY: PermissionSnapshot = {
  isSuper: false,
  permissions: ['union.pid'],
  stepUp: { 'union.pid': { tier: 'totp', operations: {} } },
};
/** The placeholder / mark of a planned operation (apps/admin/src/texts/shell.ts). */
export const PLANNED = '功能开发中';
/**
 * A hint that the account choices could not be read: any common wording (读取出错 / 请求失败 /
 * 暂不可用 / 无法… / …失败 / 读不到 / 出错 / 错误).
 */
export const UNAVAILABLE = /读取不到|读不到|出错|错误|失败|无法|不可用|暂时无法/;

export interface MountOptions extends Omit<BackendOptions, 'granted'> {
  readonly snapshot?: PermissionSnapshot | undefined;
  /** Not given: the shell gets no planned list (nothing blocked). */
  readonly planned?: ReadonlySet<string> | undefined;
}

export async function mountPage(options: MountOptions = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const snapshot = options.snapshot ?? PERMITTED;
  const api: Backend = backend({
    granted: snapshot.permissions,
    server: options.server,
    optionsMode: options.optionsMode,
  });
  const onError = vi.fn();
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: api.fetch,
    getToken: () => 'example-admin-token',
    onError,
  });
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
    ...(options.planned === undefined ? {} : { plannedOperations: options.planned }),
  });
  await act(async () => {
    render(element);
  });
  return { api, server: api.server, onError, directFetch };
}

/** No request in flight and React has flushed what followed the last one. */
export async function quietly(api: { readonly pending: number }): Promise<void> {
  await waitFor(() => expect(api.pending).toBe(0));
  await settle();
  await settle();
}

/**
 * The default 「联盟账号」 tab has read its list and alert phones (both under
 * /admin/v1/union-accounts) and shows the list (an account name).
 */
export async function accountsTabShown(api: Backend, name: string): Promise<void> {
  await waitFor(() => expect(main().textContent).toContain(name));
  await waitFor(() => expect(api.sent('GET', ACCOUNTS)).toHaveLength(1));
  await waitFor(() => expect(api.sent('GET', PHONES)).toHaveLength(1));
  await quietly(api);
}

/** No error toast (message / notification) anywhere. */
export function noToast(): void {
  expect(document.querySelectorAll('.ant-message-notice, .ant-notification-notice')).toHaveLength(
    0,
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
  return scopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll<HTMLElement>('.ant-select-item-option-content')),
  );
}

/** The one select (antd or native) labelled `label` inside `scope`. */
export function selectOf(scope: HTMLElement, label: RegExp): HTMLElement {
  const combos = within(scope).queryAllByRole('combobox', { name: label });
  expect(combos, `one select labelled ${String(label)}`).toHaveLength(1);
  return combos[0]!;
}

/**
 * Opens the select labelled `label`, lets pending reads finish, returns the option texts it
 * offers (none when it is disabled or empty) and closes it again without choosing.
 */
export async function offeredNow(
  scope: HTMLElement,
  label: RegExp,
  api: { readonly pending: number },
): Promise<string[]> {
  const combo = selectOf(scope, label);
  if (combo instanceof HTMLSelectElement)
    return Array.from(combo.options)
      .filter((item) => item.value !== '')
      .map((item) => item.text.trim());
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  await quietly(api);
  const texts = optionNodes(combo).map((node) => (node.textContent ?? '').trim());
  await act(async () => {
    fireEvent.keyDown(combo, { key: 'Escape', code: 'Escape', keyCode: 27 });
  });
  await settle();
  return texts;
}

/**
 * Chooses the option matching `option` in the select labelled `label` when it is offered; returns
 * whether it was (no assertion: a dialog without choices may offer none).
 */
export async function chooseIfOffered(
  scope: HTMLElement,
  label: RegExp,
  option: RegExp,
  api: { readonly pending: number },
): Promise<boolean> {
  const combo = selectOf(scope, label);
  if (combo instanceof HTMLSelectElement) {
    const target = Array.from(combo.options).find((item) => option.test(item.text.trim()));
    if (target === undefined) return false;
    await act(async () => {
      fireEvent.change(combo, { target: { value: target.value } });
    });
    return true;
  }
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  await quietly(api);
  const target = optionNodes(combo).find((node) => option.test((node.textContent ?? '').trim()));
  if (target === undefined) {
    await act(async () => {
      fireEvent.keyDown(combo, { key: 'Escape', code: 'Escape', keyCode: 27 });
    });
    return false;
  }
  await act(async () => {
    fireEvent.click(target);
  });
  await quietly(api);
  return true;
}

/**
 * Text that a hint about the account select may sit in: the dialog's text (alerts, placeholder,
 * help) and the select's own title / aria-label / aria-description / described-by texts.
 */
export function accountHintText(form: HTMLElement, label: RegExp): string {
  const combo = selectOf(form, label);
  const texts: (string | null | undefined)[] = [
    form.textContent,
    combo.getAttribute('title'),
    combo.getAttribute('aria-label'),
    combo.getAttribute('aria-description'),
    combo.getAttribute('placeholder'),
  ];
  for (const id of (combo.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
    texts.push(document.getElementById(id)?.textContent);
  return texts.filter((text): text is string => typeof text === 'string').join('\n');
}

/** Closes a PID dialog with its 【取消】 and waits until no dialog titled `title` is open. */
export async function closeDialog(form: HTMLElement, title: RegExp): Promise<void> {
  await click(action(form, /^取消/));
  await waitFor(() => expect(dialogs(title)).toEqual([]));
  await settle();
}

/**
 * Opens 【修改】 of the pending row `pid` (whose account is `own`): its account select offers no
 * account of `names` (at most the row's own account id it already holds), a hint matching `hint`
 * sits in the dialog / on the select, and the dialog is closed again.
 */
export async function editOffersNone(
  api: { readonly pending: number },
  pid: string,
  own: string,
  names: readonly string[],
  hint: RegExp,
): Promise<void> {
  const form = await openEdit(pid);
  await quietly(api);
  const offered = await offeredNow(form, LABEL.account, api);
  const joined = offered.join('|');
  for (const name of names) expect(joined).not.toContain(name);
  for (const text of offered) expect(text).toContain(own);
  await waitFor(() => expect(accountHintText(form, LABEL.account)).toMatch(hint));
  await closeDialog(form, /修改/);
}
