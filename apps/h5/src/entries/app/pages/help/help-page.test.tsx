import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../../../shared/api/app-api.ts';
import { createApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { helpTexts } from '../../../../texts/help.ts';
import { HelpPage } from './index.ts';
import type { HelpBridge } from './parts.tsx';
import { MemoryRouter, useNavigate } from './router.ts';

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
});

/** Past the page's five-minute staleTime. */
const AFTER_STALE_MS = 6 * 60 * 1000;

function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 't' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const summary = {
  article_id: 'a',
  category: 'help',
  title: 'title a',
  version: 1,
  published_at: '2026-10-01T00:00:00Z',
};
const body = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body a' }] }],
});

/** Fake HTTP boundary: the list holds article a; the article answers from `details` in turn. */
function fakeApi(details: (() => Response)[]) {
  const requests: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    if (url.pathname === '/v1/articles') return reply({ items: [summary], next_cursor: null });
    const next = details.shift();
    return next === undefined ? reply(null, 50001, 500) : next();
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({}),
    fetch,
  });
  return { api, requests };
}

function GoHome() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate('/help')}>
      go-home
    </button>
  );
}

const outsideApp: HelpBridge = {
  isInApp: () => false,
  has: () => null,
  call: () => Promise.reject(new Error('unexpected call')),
};

function mount(api: ReturnType<typeof fakeApi>['api']) {
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      <ApiProvider api={api}>
        <MemoryRouter initialEntries={['/help?article_id=a']}>
          <HelpPage bridge={outsideApp} />
          <GoHome />
        </MemoryRouter>
      </ApiProvider>,
      client,
    ),
  );
}

/** Loads article a, goes home, lets the cache go stale, then opens article a again. */
async function reopenAfterStale(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByText('body a');
  await user.click(screen.getByRole('button', { name: 'go-home' }));
  const entry = await screen.findByRole('button', { name: 'title a' });
  vi.setSystemTime(Date.now() + AFTER_STALE_MS);
  await user.click(entry);
}

it('an article taken offline after it was cached shows the offline state, not the stale body', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const http = fakeApi([() => reply({ ...summary, body }), () => reply(null, 30701, 404)]);
  mount(http.api);
  await reopenAfterStale();
  await screen.findByText(helpTexts.notFoundTitle);
  expect(screen.queryByText('body a')).toBeNull();
  expect(screen.getByRole('button', { name: helpTexts.backHome })).toBeTruthy();
  expect(http.requests.filter((url) => url.pathname === '/v1/articles/a')).toHaveLength(2);
});

it('another failure of a stale refetch keeps the article already loaded', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const http = fakeApi([() => reply({ ...summary, body }), () => reply(null, 50001, 500)]);
  mount(http.api);
  await reopenAfterStale();
  await waitFor(() =>
    expect(http.requests.filter((url) => url.pathname === '/v1/articles/a')).toHaveLength(2),
  );
  await screen.findByText('body a');
  expect(screen.queryByText(helpTexts.notFoundTitle)).toBeNull();
});
