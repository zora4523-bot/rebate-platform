import { createElement, useEffect } from 'react';
import { act, cleanup, configure, render, screen } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { NoticePage } from '../../../../apps/h5/src/entries/app/pages/notices/index.ts';
import { AgreementPage } from '../../../../apps/h5/src/entries/app/pages/agreements/index.ts';
import {
  MemoryRouter,
  useLocation,
  useNavigate,
} from '../../../../apps/h5/src/entries/app/pages/notices/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

export function mount(api: H5ApiClient | null, path = '/notice') {
  const client = createQueryClient();
  clients.push(client);
  let navigate: ReturnType<typeof useNavigate> | undefined;
  function RoutedPage() {
    const location = useLocation();
    const go = useNavigate();
    useEffect(() => {
      navigate = go;
    }, [go]);
    return createElement(
      'div',
      null,
      createElement('output', { 'data-testid': 'location' }, location.pathname + location.search),
      location.pathname === '/agreement'
        ? createElement(AgreementPage, {})
        : createElement(NoticePage, {}),
    );
  }
  const view = render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(RoutedPage)),
      ),
      client,
    ),
  );
  return {
    ...view,
    async go(to: string | number) {
      expect(navigate).toBeDefined();
      await act(async () => {
        if (typeof to === 'number') await navigate!(to);
        else await navigate!(to);
      });
    },
  };
}

/** Cards may be links or buttons; their accessible name may also contain summary/date. */
export function entry(title: string | RegExp): HTMLElement {
  const controls = [
    ...screen.queryAllByRole('button', { name: title }),
    ...screen.queryAllByRole('link', { name: title }),
  ];
  expect(controls, '唯一可访问入口').toHaveLength(1);
  return controls[0]!;
}

export const LOADING = '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]';
