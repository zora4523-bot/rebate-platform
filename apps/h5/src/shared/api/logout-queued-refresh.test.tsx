import type { BridgeEvent, BridgeRequest, BridgeTransport } from '@couli/bridge-sdk';
import { bridge } from '@couli/contracts-ts';
import { useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppShell } from '../../entries/app/app-shell.tsx';
import { clearAccountData, createQueryClient, createQueryProvider } from '../query.ts';

// 单元测试：真实壳层 + 真实流水页；原生边界用假的 __REBATE_BRIDGE__，HTTP 用假的 fetch，
// 哨兵用可手动触发的 IntersectionObserver；不联网、不 listen。
// 场景（Codex r2 S1）：翻页在途时下拉刷新被排队，随后退出登录；取消查询让旧翻页结束并执行
// 排队的刷新，这次刷新不得再取令牌、不得发请求。

const observers = new Set<FakeObserver>();
const releases: (() => void)[] = [];

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

afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0)) release();
  observers.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

const NATIVE_ENV = {
  platform: 'android',
  app_version: '2.4.6',
  build: '2468',
  channel: 'official',
  os_version: '15',
  bridge_version: 1,
  safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
};

function reply(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data, trace_id: 't' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(amountFen: number, next: string | null) {
  return reply({
    items: [
      {
        ledger_type: 'REBATE_CREDIT',
        sub_type: null,
        amount_fen: amountFen,
        accounting_date: '2026-10-12',
        link_type: null,
        link_id: null,
        masked: false,
        balance_after_fen: 100_000,
      },
    ],
    next_cursor: next,
  });
}

function nativeBridge() {
  const listeners = new Set<(event: BridgeEvent) => void>();
  let tokenCalls = 0;
  const transport: BridgeTransport = {
    version: 1,
    methods: ['app.getEnv', 'auth.getH5Token'],
    postMessage: (request: BridgeRequest) => {
      if (request.method === 'app.getEnv')
        return { id: request.id, code: 0, msg: '', data: NATIVE_ENV };
      tokenCalls += 1;
      return {
        id: request.id,
        code: 0,
        msg: '',
        data: {
          token: `h5-unit-${tokenCalls}`,
          scope: 'standard',
          expire_at: '2099-01-01T00:00:00Z',
        },
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return {
    tokenCalls: () => tokenCalls,
    async change(loggedIn: boolean) {
      await act(async () => {
        for (const listener of listeners) {
          listener({ event: 'auth.changed', data: { logged_in: loggedIn } });
        }
      });
    },
  };
}

function wire(handler: (count: number) => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    return handler(requests.length);
  });
  return requests;
}

function held<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releases.push(() => pending.resolve(fallback));
  return pending;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

function pullDown(): void {
  const main = screen.getByRole('main');
  act(() => {
    fireEvent.touchStart(main, { touches: [{ identifier: 1, clientX: 100, clientY: 30 }] });
    fireEvent.touchMove(main, { touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(main, { touches: [] });
  });
}

it('翻页在途时排队的下拉刷新，在退出登录后不取令牌、不发请求', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.fixture.invalid');
  vi.stubEnv('VITE_APP_ID', 'fixture_brand');
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  const native = nativeBridge();
  const nextPage = held(page(202, null));
  const requests = wire((count) => (count === 1 ? page(101, 'c1') : nextPage.promise));
  window.history.replaceState(null, '', bridge.routes.Ledger.h5_path!);
  const view = render(createAppShell());

  await waitFor(() => expect(view.container.textContent).toMatch(/1\.01/));
  expect(requests).toHaveLength(1);
  expect(native.tokenCalls()).toBe(1);

  // 翻页请求挂起，期间下拉刷新只会被排队。
  reachBottom();
  await waitFor(() => expect(requests).toHaveLength(2));
  pullDown();
  await flush();
  expect(requests).toHaveLength(2);

  await native.change(false);
  await flush();
  nextPage.resolve(page(202, null));
  await flush();

  expect(view.container.textContent).not.toMatch(/1\.01|2\.02/);
  expect(native.tokenCalls()).toBe(1);
  expect(requests).toHaveLength(2);
});

it('换号后旧一代查询函数不再执行；换号后挂载的查询照常取数', async () => {
  const client = createQueryClient();
  const calls: string[] = [];
  let oldRefetch: (() => Promise<unknown>) | undefined;
  function Probe({ name }: { name: string }) {
    const query = useQuery({
      queryKey: ['generation-probe', name],
      queryFn: async () => {
        calls.push(name);
        return name;
      },
    });
    if (name === 'old') oldRefetch = query.refetch;
    return <p>{query.data ?? 'pending'}</p>;
  }
  const view = render(createQueryProvider(<Probe name="old" />, client));
  await screen.findByText('old');
  expect(calls).toEqual(['old']);

  view.unmount();
  clearAccountData(client);
  await act(async () => {
    await oldRefetch!();
  });
  expect(calls).toEqual(['old']);

  render(createQueryProvider(<Probe name="new" />, client));
  await screen.findByText('new');
  expect(calls).toEqual(['old', 'new']);
  client.clear();
});
