import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { click, mainElement } from '../admin-users/helpers.ts';
import { BASE_URL, PLACEHOLDER, createServer, type Server } from './search-fixtures.ts';

export { click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;

export async function mount(server = createServer(), overrides: Partial<AdminAppOptions> = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  window.history.replaceState(null, '', '/orders');
  await act(async () => {
    render(
      createAdminShell({
        permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
        router: 'memory',
        initialRoute: { menuId: 'orders' },
        dataProvider: createDataProvider({
          baseUrl: BASE_URL,
          fetch: server.fetch,
          getToken: () => 'example-admin-token',
          onError: vi.fn(),
        }),
        ...overrides,
      }),
    );
  });
  return { server, directFetch };
}

export async function region(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(screen.queryByRole('banner')?.querySelector('[role="search"]') ?? null).not.toBeNull(),
  );
  const banner = screen.queryByRole('banner');
  expect(banner, 'top bar').not.toBeNull();
  const found = within(banner!).queryByRole('search');
  expect(found, 'top-bar search landmark').not.toBeNull();
  return found!;
}

export async function input(): Promise<HTMLInputElement> {
  const found = within(await region()).queryByPlaceholderText(PLACEHOLDER);
  expect(found, 'search input with specified placeholder').toBeInstanceOf(HTMLInputElement);
  return found as HTMLInputElement;
}

export async function fill(value: string): Promise<HTMLInputElement> {
  const box = await input();
  await act(async () => {
    fireEvent.change(box, { target: { value } });
    box.focus();
  });
  return box;
}

export async function submit(value: string, by: 'enter' | 'button' = 'enter'): Promise<void> {
  const box = await fill(value);
  if (by === 'enter') await userEvent.keyboard('{Enter}');
  else await click(await searchButton());
  expect(box.value, 'submission retains a nonempty query').not.toBe('');
}

export async function searchButton(): Promise<HTMLElement> {
  const button = (await region()).querySelector<HTMLElement>('.ant-input-search-button');
  expect(button, 'antd magnifier submit button').not.toBeNull();
  return button!;
}

export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}

export async function listbox(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull());
  return screen.getByRole('listbox');
}

export async function options(): Promise<HTMLElement[]> {
  return within(await listbox()).queryAllByRole('option');
}

export async function key(value: string): Promise<void> {
  await userEvent.keyboard(value);
}
