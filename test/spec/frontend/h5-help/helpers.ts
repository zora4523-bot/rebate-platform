import { createElement } from 'react';
import {
  MemoryRouter,
  useLocation,
  useNavigate,
} from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import {
  HelpPage,
  type HelpPageProps,
} from '../../../../apps/h5/src/entries/app/pages/help/index.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { fakeBridge } from './fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    'aside',
    {},
    createElement('output', { 'data-testid': 'location' }, location.pathname + location.search),
    createElement(
      'button',
      {
        onClick: () => {
          void navigate(-1);
        },
      },
      'fixture-back',
    ),
  );
}

export function mount(
  api: H5ApiClient | null,
  options: { url?: string; bridge?: HelpPageProps['bridge'] } = {},
) {
  const client = createQueryClient();
  clients.push(client);
  const view = render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(
          MemoryRouter,
          { initialEntries: [options.url ?? '/help'] },
          createElement(HelpPage, { bridge: options.bridge ?? fakeBridge().bridge }),
          createElement(HistoryProbe),
        ),
      ),
      client,
    ),
  );
  return { ...view, client };
}

export function entry(name: string | RegExp): HTMLElement {
  const controls = [
    ...screen.queryAllByRole('button', { name }),
    ...screen.queryAllByRole('link', { name }),
  ];
  expect(controls, `唯一可访问入口 ${String(name)}`).toHaveLength(1);
  return controls[0]!;
}

export function paths(requests: Request[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

export function expectListQuery(request: Request, cursor?: string): void {
  const query = new URL(request.url).searchParams;
  expect(query.getAll('category')).toEqual(['help']);
  expect(query.getAll('cursor')).toEqual(cursor === undefined ? [] : [cursor]);
  expect([...query.keys()].filter((key) => !['category', 'cursor', 'limit'].includes(key))).toEqual(
    [],
  );
  expect(query.getAll('limit').length).toBeLessThanOrEqual(1);
  if (query.has('limit')) {
    expect(query.get('limit')).toMatch(/^\d+$/);
    expect(Number(query.get('limit'))).toBeGreaterThanOrEqual(1);
    expect(Number(query.get('limit'))).toBeLessThanOrEqual(50);
  }
  expect(request.method).toBe('GET');
}
