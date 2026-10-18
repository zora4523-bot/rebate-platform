import { createElement } from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { ConfigCenterPage } from '../../../../apps/admin/src/pages/config-center/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  button,
  click,
  dialog,
  expectText,
  mainElement,
  nameOf,
} from '../admin-platform-icons/helpers.ts';
import { BASE_URL, GROUPS, LIST, REASON, TARGET, createServer, type Server } from './fixtures.ts';

export { button, click, dialog, expectText, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

export async function mount(
  server: Server = createServer(),
  snapshot = SUPER,
  defaultRoute = false,
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
  // Await the shell's permission render so NotImplemented is attributed to the current test.
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
        initialRoute: { menuId: 'config' },
        dataProvider,
        ...(defaultRoute
          ? {}
          : { renderPage: (_menu, access) => createElement(ConfigCenterPage, { access }) }),
      }),
    );
  });
  return { server, directFetch };
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export function row(key = TARGET): HTMLElement {
  const node = within(mainElement()).queryByText(key, { exact: true });
  expect(node, `listed key ${key}`).not.toBeNull();
  const result = node!.closest<HTMLElement>('tr, [role="row"]');
  expect(result, `table row ${key}`).not.toBeNull();
  return result!;
}
export async function loaded(key = TARGET): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryByText(key, { exact: true })).not.toBeNull(),
  );
}
export function navigation(): HTMLElement[] {
  return ['menuitem', 'tab', 'button']
    .flatMap((role) => within(mainElement()).queryAllByRole(role))
    .filter((node) =>
      [...GROUPS, '其他', '普通配置', '通用配置'].some((name) =>
        (node.textContent ?? '').includes(name),
      ),
    );
}
/** Discover group placement via visible controls; tests never mandate a permission/key registry. */
export async function reveal(key: string, server: Server): Promise<void> {
  await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
  await settled(server);
  if (within(mainElement()).queryByText(key, { exact: true })) return;
  for (const node of navigation()) {
    await click(node);
    await settled(server);
    if (within(mainElement()).queryByText(key, { exact: true })) return;
  }
  await loaded(key);
}
export function column(key: string, title: RegExp): HTMLElement {
  const current = row(key);
  const table = current.closest('table');
  expect(table).not.toBeNull();
  const index = within(table!)
    .getAllByRole('columnheader')
    .findIndex((node) => title.test(node.textContent ?? ''));
  expect(index, `column ${title}`).toBeGreaterThanOrEqual(0);
  const cell = current.children[index];
  expect(cell).toBeDefined();
  return cell as HTMLElement;
}
export function enabled(element: HTMLElement): boolean {
  return (
    !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true'
  );
}
export function editButton(key = TARGET): HTMLButtonElement {
  return button(row(key), /编辑/);
}
export function openDrawers(): HTMLElement[] {
  return screen
    .queryAllByRole('dialog')
    .filter((node) => node.closest('.ant-drawer-open') !== null);
}
export async function drawer(): Promise<HTMLElement> {
  await waitFor(() => expect(openDrawers()).toHaveLength(1));
  return openDrawers()[0]!;
}
export async function openEditor(server: Server, key = TARGET): Promise<HTMLElement> {
  await reveal(key, server);
  await click(editButton(key));
  return drawer();
}
export async function input(element: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(element, { target: { value } });
    fireEvent.blur(element);
  });
}
export async function reason(scope: HTMLElement, value = REASON): Promise<void> {
  await input(within(scope).getByRole('textbox', { name: /修改原因/ }), value);
}
export async function numberValue(scope: HTMLElement, value = '7'): Promise<void> {
  await input(within(scope).getByRole('spinbutton', { name: /新值/ }), value);
}
export async function confirmation(): Promise<HTMLElement> {
  const find = () =>
    screen
      .queryAllByRole('dialog')
      .filter(
        (node) => node.closest('.ant-drawer') === null && !nameOf(node).startsWith('二次验证'),
      );
  await waitFor(() => expect(find()).toHaveLength(1));
  return find()[0]!;
}
export async function prepare(server: Server, key = TARGET, value = '7'): Promise<HTMLElement> {
  const edit = await openEditor(server, key);
  await numberValue(edit, value);
  await reason(edit);
  await click(button(edit, /保存/));
  return confirmation();
}
export async function approve(modal: HTMLElement, twice = false): Promise<void> {
  // A rollback may collect its reason in the confirmation instead of reusing the drawer.
  for (const field of within(modal).queryAllByRole('textbox', { name: /原因/ }))
    await input(field, REASON);
  const submit = button(modal, /确认|验证并|保存|回滚/);
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
}
export async function verify(modal: HTMLElement, twice = false): Promise<void> {
  await input(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  const submit = button(modal, '验证并继续');
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
}
export async function submit(
  server: Server,
  key = TARGET,
  value = '7',
  sensitive = true,
): Promise<void> {
  await approve(await prepare(server, key, value));
  if (sensitive) await verify(await dialog('二次验证 · 动态码'));
}
export async function currentValue(key: string, pattern: RegExp): Promise<void> {
  await waitFor(() => expect(column(key, /当前值/).textContent).toMatch(pattern));
}
export async function versionRow(scope: HTMLElement, version: number): Promise<HTMLElement> {
  const pattern = new RegExp(`^v?${version}$`);
  const find = () =>
    within(scope)
      .queryAllByRole('row')
      .filter((node) => within(node).queryAllByText(pattern).length > 0);
  await waitFor(() => expect(find()).toHaveLength(1));
  return find()[0]!;
}
export async function prepareRollback(server: Server, key = TARGET): Promise<HTMLElement> {
  const edit = await openEditor(server, key);
  await reason(edit);
  const old = await versionRow(edit, 2);
  await click(button(old, /^回滚.*到\s*v2(?!\d)/));
  return confirmation();
}
export async function alert(pattern: RegExp): Promise<void> {
  await waitFor(() =>
    expect(
      screen.queryAllByRole('alert').some((node) => pattern.test(node.textContent ?? '')),
    ).toBe(true),
  );
}
