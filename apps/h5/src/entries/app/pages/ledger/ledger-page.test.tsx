import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../../../shared/api/app-api.ts';
import { createApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { t } from '../../../../shared/texts.ts';
import { ledgerTexts } from '../../../../texts/ledger.ts';
import { LedgerPage } from './index.ts';

// 单元测试：HTTP 边界用假的 fetch（不联网、不 listen），哨兵用可手动触发的 IntersectionObserver。

const clients: ReturnType<typeof createQueryClient>[] = [];
const observers = new Set<FakeObserver>();

class FakeObserver {
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  observers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 't' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function entry(amountFen: number) {
  return {
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    amount_fen: amountFen,
    accounting_date: '2026-10-12',
    link_type: null,
    link_id: null,
    masked: false,
    balance_after_fen: 100_000,
  };
}

function page(amountFen: number, next: string | null = null) {
  return reply({ items: [entry(amountFen)], next_cursor: next });
}

/** 记录每个请求，并统计同一时间最多有几个请求在途。 */
function fakeApi(handler: (url: URL, count: number) => Response | Promise<Response>) {
  const requests: URL[] = [];
  let open = 0;
  let maxOpen = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    try {
      return await handler(url, requests.length);
    } finally {
      open -= 1;
    }
  };
  const api = createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({}),
    fetch,
  });
  return {
    api,
    requests,
    maxOpen: () => maxOpen,
  };
}

function mount(api: ReturnType<typeof fakeApi>['api']) {
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      <ApiProvider api={api}>
        <LedgerPage />
      </ApiProvider>,
      client,
    ),
  );
}

function pullDown(): void {
  const main = screen.getByRole('main');
  act(() => {
    fireEvent.touchStart(main, { touches: [{ identifier: 1, clientX: 100, clientY: 30 }] });
    fireEvent.touchMove(main, { touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(main, { touches: [] });
  });
}

function reachBottom(): void {
  act(() => {
    for (const observer of observers) {
      observer.callback(
        Array.from(
          observer.targets,
          (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
        ),
        observer as unknown as IntersectionObserver,
      );
    }
  });
}

it('a failed pull-to-refresh keeps the loaded rows, shows an alert and retries once on demand', async () => {
  const http = fakeApi((_url, count) => {
    if (count === 1) return page(101);
    if (count === 2) return reply(null, 50001, 500);
    return page(202);
  });
  mount(http.api);
  await screen.findByText(/1\.01/);
  expect(screen.queryByRole('alert')).toBeNull();

  pullDown();
  expect((await screen.findByRole('alert')).textContent).toBe(ledgerTexts.refreshFailed);
  expect(screen.getByText(/1\.01/)).toBeTruthy();
  expect(http.requests).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: ledgerTexts.retry }));
  await screen.findByText(/2\.02/);
  expect(http.requests).toHaveLength(3);
  expect(http.requests[2]!.searchParams.has('cursor')).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a refresh answering 10405 shows the 10405 text and is never replayed automatically', async () => {
  const http = fakeApi((_url, count) => (count === 1 ? page(101) : reply(null, 10405, 403)));
  mount(http.api);
  await screen.findByText(/1\.01/);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  pullDown();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByRole('alert').textContent).toBe(t('error.10405'));
  expect(screen.getByText(/1\.01/)).toBeTruthy();
  expect(screen.getByRole('button', { name: ledgerTexts.retry })).toBeTruthy();
  expect(http.requests).toHaveLength(2);
});

it('a refresh while the next page is in flight waits for it, so only one request is ever open', async () => {
  const more = Promise.withResolvers<Response>();
  const http = fakeApi((url, count) => {
    if (url.searchParams.has('cursor')) return more.promise;
    return count === 1 ? page(101, 'c1') : page(303);
  });
  mount(http.api);
  await screen.findByText(/1\.01/);

  reachBottom();
  await waitFor(() => expect(http.requests).toHaveLength(2));
  pullDown();
  pullDown();
  await act(async () => {});
  expect(http.requests).toHaveLength(2);

  await act(async () => {
    more.resolve(page(202));
  });
  await screen.findByText(/3\.03/);
  await act(async () => {});
  expect(http.requests).toHaveLength(3);
  expect(http.requests[2]!.searchParams.has('cursor')).toBe(false);
  expect(http.maxOpen()).toBe(1);
  expect(screen.queryByText(/2\.02/)).toBeNull();
});

it('reaching the bottom during a refresh does not start a next-page request', async () => {
  const refresh = Promise.withResolvers<Response>();
  const http = fakeApi((_url, count) => (count === 1 ? page(101, 'c1') : refresh.promise));
  mount(http.api);
  await screen.findByText(/1\.01/);

  pullDown();
  await waitFor(() => expect(http.requests).toHaveLength(2));
  reachBottom();
  await act(async () => {});
  expect(http.requests).toHaveLength(2);
  await act(async () => {
    refresh.resolve(page(404));
  });
  await screen.findByText(/4\.04/);
  expect(http.maxOpen()).toBe(1);
});
