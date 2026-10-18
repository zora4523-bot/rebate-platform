import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ApiProvider } from '../../../../shared/api/app-api.ts';
import { createApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { noticesTexts } from '../../../../texts/notices.ts';
import { agreementsTexts } from '../../../../texts/agreements.ts';
import { AgreementPage } from '../agreements/index.ts';
import { NoticePage } from './index.ts';
import { MemoryRouter } from './router.ts';

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 't' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function article(id: string) {
  return {
    article_id: id,
    category: 'notice',
    title: `title ${id}`,
    version: 2,
    published_at: '2026-10-01T00:00:00+08:00',
    body: JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `body ${id}` }] }],
    }),
  };
}

/** The article is published until `withdraw()`; afterwards every detail request answers 30701. */
function fakeApi() {
  let withdrawn = false;
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(url.pathname);
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    return withdrawn ? reply(null, 30701, 404) : reply(article(id));
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({}),
    fetch,
  });
  return {
    api,
    requests,
    withdraw() {
      withdrawn = true;
    },
  };
}

function renderAt(
  client: ReturnType<typeof createQueryClient>,
  api: ReturnType<typeof fakeApi>['api'],
  path: string,
) {
  const page = path.startsWith('/agreement') ? <AgreementPage /> : <NoticePage />;
  return render(
    createQueryProvider(
      <ApiProvider api={api}>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </ApiProvider>,
      client,
    ),
  );
}

for (const [path, id, goneText] of [
  ['/notice?article_id=n1', 'n1', noticesTexts.goneTitle],
  ['/agreement?type=privacy', 'privacy', agreementsTexts.unpublishedTitle],
] as const) {
  it(`${path}: a refetch answering 30701 replaces the cached text with the withdrawn state`, async () => {
    const client = createQueryClient();
    clients.push(client);
    const http = fakeApi();
    const first = renderAt(client, http.api, path);
    expect(await screen.findByText(`body ${id}`)).toBeTruthy();
    first.unmount();

    // Taken down after it was read; the cached entry is stale when the page is opened again.
    http.withdraw();
    await client.invalidateQueries({ refetchType: 'none' });
    renderAt(client, http.api, path);
    expect(await screen.findByText(goneText)).toBeTruthy();
    expect(screen.queryByText(`body ${id}`)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(http.requests).toEqual([`/v1/articles/${id}`, `/v1/articles/${id}`]);
  });
}
