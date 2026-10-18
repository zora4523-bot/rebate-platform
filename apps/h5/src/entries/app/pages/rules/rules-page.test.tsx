import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { ApiProvider } from '../../../../shared/api/app-api.ts';
import { createApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { RulesPage } from './index.ts';

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function summary(id: string) {
  return {
    article_id: id,
    category: 'rule',
    title: `title ${id}`,
    version: 1,
    published_at: '2026-10-01T00:00:00+08:00',
  };
}

function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 't' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function doc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

/** Fake HTTP boundary: two list pages (cursor c1), the second fails `failures` times first. */
function fakeApi(failures = 0) {
  const requests: URL[] = [];
  let left = failures;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    if (url.pathname === '/v1/articles') {
      if (url.searchParams.get('cursor') === null)
        return reply({ items: [summary('a'), summary('b')], next_cursor: 'c1' });
      if (left > 0) {
        left -= 1;
        return reply(null, 50001, 500);
      }
      return reply({ items: [summary('b'), summary('c')], next_cursor: null });
    }
    const id = url.pathname.split('/').at(-1)!;
    return reply({ ...summary(id), body: doc(`body ${id}`) });
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({}),
    fetch,
  });
  return { api, requests };
}

function mount(element: Parameters<typeof createQueryProvider>[0]) {
  const client = createQueryClient();
  clients.push(client);
  return render(createQueryProvider(element, client));
}

function listCursors(requests: URL[]): (string | null)[] {
  return requests
    .filter((url) => url.pathname === '/v1/articles')
    .map((url) => url.searchParams.get('cursor'));
}

it('follows next_cursor once per page until it is null and lists every later article', async () => {
  const http = fakeApi();
  mount(<RulesPage api={http.api} />);
  await screen.findByText('body a');
  await screen.findByRole('button', { name: 'title c' });
  expect(screen.getAllByRole('button', { name: 'title b' })).toHaveLength(1);
  expect(listCursors(http.requests)).toEqual([null, 'c1']);
});

it('a failed later page keeps the article and retries only that page', async () => {
  const http = fakeApi(1);
  mount(<RulesPage api={http.api} />);
  await screen.findByText('body a');
  await screen.findByRole('alert');
  expect(listCursors(http.requests)).toEqual([null, 'c1']);
  await userEvent.setup().click(screen.getByRole('button', { name: /重试/ }));
  await screen.findByRole('button', { name: 'title c' });
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(listCursors(http.requests)).toEqual([null, 'c1', 'c1']);
});

it('uses the App API client from the provider when none is injected', async () => {
  const http = fakeApi();
  mount(
    <ApiProvider api={http.api}>
      <RulesPage />
    </ApiProvider>,
  );
  expect((await screen.findByText('body a')).tagName).toBe('P');
  expect(listCursors(http.requests)).toEqual([null, 'c1']);
});

it('keeps the placeholder and sends nothing without any API client', () => {
  const view = mount(<RulesPage />);
  expect(view.container.textContent?.trim().length).toBeGreaterThan(0);
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
});
