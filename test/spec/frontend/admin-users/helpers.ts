import { createElement } from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { UsersPage } from '../../../../apps/admin/src/pages/users/index.ts';
import {
  createAccessControl,
  type PermissionSnapshot,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, dialog, expectText, mainElement } from '../admin-platform-icons/helpers.ts';
import { BASE_URL, UID, REASON, LIST, createServer, type Server } from './fixtures.ts';

export { button, click, dialog, expectText, mainElement };
export { verify } from '../admin-kill-switches/helpers.ts';
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

export async function mount(server = createServer(), snapshot = SUPER, defaultRoute = false) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const access = createAccessControl(snapshot);
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        // The explicit page harness also exercises the page's own denial state, bypassing the
        // shell's redirect only when neither page permission exists. Default-route tests do not.
        permissionsProvider: async () =>
          !defaultRoute && !access.can('user.list') && !access.can('user.lookup')
            ? SUPER
            : snapshot,
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
        initialRoute: { menuId: 'users' },
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
        ...(defaultRoute ? {} : { renderPage: () => createElement(UsersPage, { access }) }),
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
export async function loaded(uid = UID): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryAllByText(uid, { exact: true }).length).toBeGreaterThan(0),
  );
}
export function row(uid = UID): HTMLElement {
  const node = within(mainElement()).queryByText(uid, { exact: true });
  expect(node, `listed UID ${uid}`).not.toBeNull();
  const result = node!.closest<HTMLElement>('tr');
  expect(result, `row ${uid}`).not.toBeNull();
  return result!;
}
export async function openDetail(uid = UID): Promise<void> {
  await loaded(uid);
  await click(button(row(uid), /^详情(?:\s|$)/));
}
export async function detailLoaded(code = 'K7QX2M'): Promise<void> {
  await waitFor(() => expect(mainElement().textContent).toContain(code));
}
export function searchBox(): HTMLInputElement {
  const found = within(mainElement())
    .queryAllByRole('textbox')
    .filter((node) => node instanceof HTMLInputElement);
  expect(found, 'one UID / phone search box').toHaveLength(1);
  return found[0] as HTMLInputElement;
}
export async function lookup(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(searchBox(), { target: { value } });
  });
  await click(button(mainElement(), /^(查找|查询|搜索)$/));
}
export async function nextPage(): Promise<void> {
  const next = mainElement().querySelector<HTMLElement>(
    '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
  );
  expect(next, 'page-number pagination next control').not.toBeNull();
  await click(next!);
}
export async function filterRisk(label: string): Promise<void> {
  const input = within(mainElement()).queryByRole('combobox', { name: /风控状态/ });
  expect(input, 'labelled risk-state filter').not.toBeNull();
  await act(async () => {
    fireEvent.mouseDown(input!);
  });
  // Match the visible option, not rc-select's virtual accessibility mirror.
  const option = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown .ant-select-item-option-content',
      ),
    ).find((node) => node.textContent?.trim() === label);
  await waitFor(() => expect(option()).toBeDefined());
  await click(option()!);
}
export async function backToList(): Promise<void> {
  await click(button(mainElement(), /返回.*列表|返回用户/));
}
export async function startReveal(): Promise<HTMLElement> {
  await click(button(mainElement(), /^查看(?:完整手机号)?$/));
  // The contract requires an operator reason. A reason form precedes the existing TOTP modal.
  await waitFor(() => expect(screen.queryAllByRole('textbox', { name: /原因/ })).toHaveLength(1));
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: /原因/ }), { target: { value: REASON } });
  });
  const form =
    screen.getByRole('textbox', { name: /原因/ }).closest<HTMLElement>('[role="dialog"]') ??
    mainElement();
  await click(button(form, /^(验证并查看|确认|继续|下一步|验证并继续)$/));
  return dialog('二次验证 · 动态码');
}
export function listQueries(server: Server) {
  return server.requests('GET', LIST).map((request) => request.query);
}
