import { createElement } from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import { KillSwitchesPage } from '../../../../apps/admin/src/pages/kill-switches/index.ts';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { button, click, dialog, expectText, mainElement } from '../admin-platform-icons/helpers.ts';
import { BASE_URL, LIST, TARGET, createServer, type Server } from './fixtures.ts';

export { button, click, dialog, expectText, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
export const SUPER: PermissionSnapshot = { isSuper: true, permissions: [] };

/** Unit flows mount the skeleton explicitly; a separate test guards the default App wiring. */
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
  // Await the permission provider's render inside act: NotImplemented belongs to this test,
  // rather than React reporting it later as an unhandled error outside the test.
  await act(async () => {
    render(
      createAdminShell({
        router: 'memory',
        permissionsProvider: async () => snapshot,
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
        initialRoute: { menuId: 'switches' },
        dataProvider,
        ...(defaultRoute
          ? {}
          : {
              renderPage: ((_menu, access) =>
                createElement(KillSwitchesPage, { access })) satisfies NonNullable<
                AdminAppOptions['renderPage']
              >,
            }),
      }),
    );
  });
  return { server, directFetch };
}

export function row(key: string): HTMLElement {
  const keyNode = within(mainElement()).queryByText(key, { exact: true });
  expect(keyNode, `listed server key ${key}`).not.toBeNull();
  const result = keyNode!.closest<HTMLElement>('tr, [role="row"], [role="listitem"], li');
  expect(result, `row for ${key}`).not.toBeNull();
  return result!;
}
export function control(key: string): HTMLButtonElement {
  return within(row(key)).getByRole('switch', { hidden: true }) as HTMLButtonElement;
}
export function checked(key: string, value: boolean): void {
  expect(control(key).getAttribute('aria-checked')).toBe(String(value));
}
export async function loaded(key = TARGET): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryByText(key, { exact: true })).not.toBeNull(),
  );
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
export async function confirm(key = TARGET): Promise<HTMLElement> {
  await loaded(key);
  await click(control(key));
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(1));
  return screen.getByRole('dialog');
}
export async function stepUp(key = TARGET): Promise<HTMLElement> {
  const modal = await confirm(key);
  await click(button(modal, /验证并|确认/));
  return dialog('二次验证 · 动态码');
}
export async function verify(modal: HTMLElement, twice = false): Promise<void> {
  await act(async () => {
    fireEvent.change(within(modal).getByLabelText('动态码', { exact: true }), {
      target: { value: '123456' },
    });
  });
  const submit = button(modal, '验证并继续');
  await act(async () => {
    fireEvent.click(submit);
    if (twice) fireEvent.click(submit);
  });
}
export async function changed(server: Server, key = TARGET, value = false): Promise<void> {
  await waitFor(() => {
    expect(server.requests('PUT', `${LIST}/${key}`)).toHaveLength(1);
    checked(key, value);
  });
  await settled(server);
}
