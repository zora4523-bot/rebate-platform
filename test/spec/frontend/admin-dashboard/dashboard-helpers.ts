import { act, configure, render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { harness, signIn } from '../admin-auth/fixtures.ts';
import type { AdminAuthProvider } from '../../../../apps/admin/src/providers/auth/index.ts';
import { button, click, mainElement } from '../admin-users/helpers.ts';
import { BASE_URL, SUPER, createServer, type Server } from './dashboard-fixtures.ts';

export { button, click, mainElement };
configure({ asyncUtilTimeout: 10_000 });
export const FLOW_TIMEOUT = 40_000;
const sessions: AdminAuthProvider[] = [];
afterEach(() => {
  for (const auth of sessions.splice(0)) auth.dispose();
});

export async function mount(server = createServer(), overrides: Partial<AdminAppOptions> = {}) {
  installMediaQuery();
  const directFetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error('unexpected direct fetch')),
  );
  vi.stubGlobal('fetch', directFetch);
  const auth = harness().create();
  sessions.push(auth);
  await signIn(auth);
  window.history.replaceState(null, '', '/dashboard');
  await act(async () => {
    render(
      createAdminShell({
        router: 'browser',
        authProvider: auth,
        permissionsProvider: async () => SUPER,
        account: { username: 'ops-yi', displayName: '超管' },
        environment: 'test',
        onLogout: vi.fn(),
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
export async function loaded(): Promise<void> {
  await waitFor(() =>
    expect(within(mainElement()).queryByRole('heading', { name: /昨日概览/ })).not.toBeNull(),
  );
}
export function card(title: string): HTMLElement {
  const matches = within(mainElement()).queryAllByRole('link', {
    name: (name) => name.startsWith(`${title} `),
  });
  expect(matches, `one whole-card link for ${title}`).toHaveLength(1);
  return matches[0]!;
}
export async function settled(server: Server): Promise<void> {
  await waitFor(() => expect(server.pending).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}
