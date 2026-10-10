import { render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { createAdminShell, type AdminAppOptions } from '../../../../apps/admin/src/App.tsx';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { ADMIN_PAGE, BASE_URL, jsonResponse, requestFrom } from '../admin-data/fixtures.ts';

export type Account = Schema<'AdminAccount'>;

export function page(items: Account[], total = items.length, current = 1) {
  return {
    ...ADMIN_PAGE,
    data: { items, total, page: current, page_size: 20 },
  } satisfies Schema<'AdminAccountPageResponse'>;
}

export function mount(
  reply: (request: Request) => Promise<Response> = async () => jsonResponse(ADMIN_PAGE),
  overrides: Partial<AdminAppOptions> = {},
) {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = requestFrom(input, init);
    requests.push(request);
    return reply(request);
  });
  const dataProvider = createDataProvider({
    baseUrl: BASE_URL,
    fetch,
    getToken: () => 'example-admin-token',
    onError: vi.fn(),
  });
  const view = render(
    createAdminShell({
      router: 'memory',
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'owner', displayName: '超管' },
      environment: 'test',
      onLogout: vi.fn(),
      initialRoute: { menuId: 'admins' },
      dataProvider,
      ...overrides,
    }),
  );
  return { ...view, requests };
}

// Assertion-based waits keep a missing feature an AssertionError in the red report.
export async function tableWith(username: string): Promise<HTMLElement> {
  await waitFor(() => {
    const main = screen.queryByRole('main');
    expect(main).not.toBeNull();
    expect(main && within(main).queryByRole('table')).not.toBeNull();
    expect(main && within(main).queryByRole('cell', { name: username })).not.toBeNull();
  });
  return within(screen.getByRole('main')).getByRole('table');
}

export function cellsFor(table: HTMLElement, username: string): string[] {
  const cell = within(table).getByRole('cell', { name: username });
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  return within(row!)
    .getAllByRole('cell')
    .map((node) => node.textContent?.trim() ?? '');
}

export function requestSummary(requests: Request[]) {
  return requests.map((request) => {
    const url = new URL(request.url);
    return { method: request.method, path: `${url.pathname}${url.search}` };
  });
}
