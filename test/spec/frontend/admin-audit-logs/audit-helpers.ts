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
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, mainElement, nextPage } from '../admin-users/helpers.ts';
import { AID, BASE_URL, DONE, NOW, SUPER, createServer, type Server } from './audit-fixtures.ts';

export { button, click, mainElement, nextPage };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const auth of sessions.splice(0)) auth.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

export async function mount(
  server = createServer(),
  path = '/audit-logs',
  permissions: PermissionSnapshot = SUPER,
) {
  installMediaQuery();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('direct fetch forbidden')),
  );
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', path);
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => permissions,
        account: { username: 'ops-yi', displayName: '运营甲' },
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
  return { server, directFetch };
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export async function logsLoaded(): Promise<void> {
  await waitFor(() =>
    expect(
      within(mainElement()).queryByRole('button', { name: `查看 ${AID}` }) ??
        within(mainElement()).queryByRole('link', { name: `查看 ${AID}` }),
    ).not.toBeNull(),
  );
}
export async function exportsLoaded(id = DONE): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryByRole('cell', { name: id })).not.toBeNull(),
  );
}
/** Export lists expose a 任务编号 column; audit rows expose a named detail action. */
export function row(id: string): HTMLElement {
  const found = within(mainElement())
    .queryAllByRole('row')
    .filter(
      (node) =>
        within(node).queryByRole('cell', { name: id }) !== null ||
        within(node).queryByRole('button', { name: `查看 ${id}` }) !== null ||
        within(node).queryByRole('link', { name: `查看 ${id}` }) !== null,
    );
  expect(found, `table row ${id}`).toHaveLength(1);
  return found[0]!;
}
export async function fill(label: RegExp, value: string): Promise<void> {
  const input =
    within(mainElement()).queryByRole('textbox', { name: label }) ??
    within(mainElement()).queryByRole('combobox', { name: label });
  expect(input, `labelled field ${String(label)}`).not.toBeNull();
  await act(async () => {
    fireEvent.change(input!, { target: { value } });
    if (/时间/.test(label.source)) fireEvent.keyDown(input!, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input!);
  });
}
/** Supports antd Select or Input without tying the test to a particular filter layout. */
export async function choose(label: RegExp, value: string, display: string): Promise<void> {
  const combo = within(mainElement()).queryByRole('combobox', { name: label });
  if (!combo) return fill(label, value);
  await act(async () => {
    fireEvent.mouseDown(combo);
  });
  const option = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option-content')).find(
      (node) => node.textContent?.includes(display),
    );
  await waitFor(() => expect(option()).toBeDefined());
  await click(option()!);
}
export async function query(): Promise<void> {
  await click(button(mainElement(), /^查询$/));
}
export async function openDetail(): Promise<void> {
  await logsLoaded();
  const action =
    within(row(AID)).queryByRole('button', { name: `查看 ${AID}` }) ??
    within(row(AID)).queryByRole('link', { name: `查看 ${AID}` });
  expect(action).not.toBeNull();
  await click(action!);
}
export async function detailLoaded(): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain('normal'));
  expect(mainElement().textContent).toContain('banned');
}
export function diffRow(field: string): HTMLElement {
  const candidates = within(mainElement())
    .queryAllByRole('row')
    .filter((node) => within(node).queryAllByText(field, { exact: true }).length > 0);
  expect(candidates, `difference row ${field}`).toHaveLength(1);
  return candidates[0]!;
}
export function changed(node: HTMLElement): boolean {
  return (
    /已变更/.test(node.textContent ?? '') || within(node).queryAllByLabelText(/已变更/).length > 0
  );
}
export function expectDiff(field: string, before: string | RegExp, after: string | RegExp): void {
  const fieldRow = diffRow(field);
  const table = fieldRow.closest('table');
  expect(
    table,
    'difference table associates each value with its before/after header',
  ).not.toBeNull();
  const headers = within(table!).queryAllByRole('columnheader');
  const beforeIndex = headers.findIndex((node) => /前值|变更前/.test(node.textContent ?? ''));
  const afterIndex = headers.findIndex((node) => /后值|变更后/.test(node.textContent ?? ''));
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  const cells = within(fieldRow).queryAllByRole('cell');
  for (const [index, expected] of [
    [beforeIndex, before],
    [afterIndex, after],
  ] as const) {
    expect(cells[index]).toBeDefined();
    if (typeof expected === 'string') expect(cells[index]!.textContent).toContain(expected);
    else expect(cells[index]!.textContent).toMatch(expected);
  }
}
export function captureDownloads(): string[] {
  const urls: string[] = [];
  vi.spyOn(window, 'open').mockImplementation((url) => {
    if (url) urls.push(String(url));
    return null;
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    urls.push(this.href);
  });
  return urls;
}
