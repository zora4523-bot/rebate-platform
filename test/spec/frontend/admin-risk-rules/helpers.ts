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
import { RiskPage } from '../../../../apps/admin/src/pages/risk/index.ts';
import type {
  AccessControl,
  PermissionSnapshot,
} from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, dialog, mainElement } from '../admin-platform-icons/helpers.ts';
import { BASE_URL, TARGET, createServer, type Server } from './fixtures.ts';

export { button, click, dialog, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const PERMITTED: PermissionSnapshot = {
  isSuper: false,
  permissions: ['risk.freeze', 'config.risk'],
};
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };
const dictionaries = import.meta.glob<{ texts: Record<string, string> }>(
  '../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary = Object.values(dictionaries)[0]!.texts;
const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** Records the navigation boundary, including key/state, without adding a second editor. */
function Destination() {
  return createElement(
    'output',
    { 'aria-label': '配置中心导航' },
    JSON.stringify({
      pathname: window.location.pathname,
      search: window.location.search,
      state: window.history.state as unknown,
    }),
  );
}
export async function mount(server = createServer(), snapshot = PERMITTED, defaultRoute = false) {
  installMediaQuery();
  const session = harness().create();
  sessions.push(session);
  await signIn(session);
  window.history.replaceState(null, '', '/risk');
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: session,
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '风控运营' },
        environment: 'test',
        onLogout: vi.fn(),
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
        ...(defaultRoute
          ? {}
          : {
              renderPage: (menu: string, access: AccessControl) =>
                menu === 'risk' ? createElement(RiskPage, { access }) : createElement(Destination),
            }),
      }),
    );
  });
  return { server, directFetch };
}
export async function loaded(id = TARGET) {
  await waitFor(() =>
    expect(within(mainElement()).queryByText(id, { exact: true })).not.toBeNull(),
  );
}
export function row(id = TARGET, hidden = false): HTMLElement {
  const found = within(mainElement())
    .queryAllByRole('row', { hidden })
    .filter((entry) => within(entry).queryByText(id, { exact: true }) !== null);
  expect(found, `rule row ${id}`).toHaveLength(1);
  return found[0]!;
}
export function action(target: 'enable' | 'disable', id = TARGET): HTMLElement {
  const scope = within(row(id));
  const named = scope.queryByRole('button', { name: target === 'enable' ? /启用/ : /停用/ });
  const result = named ?? scope.queryByRole('switch');
  expect(result, `accessible ${target} action`).not.toBeNull();
  return result!;
}
export function enabled(value: boolean, id = TARGET, hidden = false) {
  const current = row(id, hidden);
  const scope = within(current);
  const table = current.closest('table, [role="table"]');
  expect(table).not.toBeNull();
  const index = within(table as HTMLElement)
    .getAllByRole('columnheader', { hidden })
    .findIndex((header) => /状态/.test(header.textContent ?? ''));
  expect(index, 'status column').toBeGreaterThanOrEqual(0);
  const cells = scope.getAllByRole('cell', { hidden });
  const code = value ? 'enabled' : 'disabled';
  expect(cells[index]!.textContent).toContain(
    dictionary[`admin_dict.risk_rule_status.${code}`] ?? code,
  );
  const toggle = scope.queryByRole('switch', { hidden });
  if (toggle !== null) expect(toggle.getAttribute('aria-checked')).toBe(String(value));
  else if (hidden) {
    // StepUpModal hides the table from accessibility; hidden buttons have no accessible name.
    const label = value ? /停用/ : /启用/;
    expect(
      scope
        .queryAllByRole('button', { hidden })
        .filter((node) => label.test(node.textContent ?? '')),
    ).toHaveLength(1);
  } else expect(scope.queryByRole('button', { name: value ? /停用/ : /启用/ })).not.toBeNull();
}
export async function settled(server: Server) {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export async function fill(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}
/** Supports a single confirmation dialog followed by the existing totp component. */
export async function start(
  target: 'enable' | 'disable' = 'disable',
  reason?: string,
  id = TARGET,
) {
  await loaded(id);
  await click(action(target, id));
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
  let modal = screen.getByRole('dialog');
  if (reason !== undefined) {
    const input = within(modal).queryByRole('textbox', { name: /原因|理由|备注/ });
    expect(input, 'optional reason field').not.toBeNull();
    await fill(input!, reason);
  }
  if (within(modal).queryByLabelText('动态码', { exact: true }) === null) {
    await click(button(modal, /确认|验证并|继续/));
    modal = await dialog('二次验证 · 动态码');
  }
  expect(within(modal).queryByLabelText('动态码', { exact: true })).not.toBeNull();
  return modal;
}
export async function verify(modal: HTMLElement) {
  await fill(within(modal).getByLabelText('动态码', { exact: true }), '123456');
  await click(button(modal, '验证并继续'));
}
export async function notice(pattern: RegExp) {
  await waitFor(() =>
    expect(
      screen.queryAllByRole('alert').some((node) => pattern.test(node.textContent ?? '')),
    ).toBe(true),
  );
}
export async function closeNoticeDialog() {
  const modal = screen.queryByRole('dialog');
  if (modal !== null) await click(button(modal, /取消|关闭/));
}
