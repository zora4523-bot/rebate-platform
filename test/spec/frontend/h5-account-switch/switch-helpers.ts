import { createElement, type ComponentType } from 'react';
import { act, cleanup, configure, render, waitFor } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import type { BridgeEvent, H5Token } from '@couli/bridge-sdk';
import { createAppShell } from '../../../../apps/h5/src/entries/app/shell.ts';
import * as appRoutes from '../../../../apps/h5/src/entries/app/routes.ts';
import { useApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { useQueryClient } from '../../../../apps/h5/src/shared/query.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { installBridge, token } from '../bridge-sdk/kit.ts';
import { buildEnv, NATIVE_ENV } from '../h5-app-api/kit.ts';
import { server } from '../h5-notices/fixtures.ts';

export { reply } from '../h5-notices/fixtures.ts';
export { list, posting } from '../h5-ledger/ledger-fixtures.ts';
export { token } from '../bridge-sdk/kit.ts';

configure({ asyncUtilTimeout: 10_000 });

type QueryClient = ReturnType<typeof useQueryClient>;
const clients = new Set<QueryClient>();
const releases: (() => void)[] = [];
const disposals: (() => void)[] = [];
export const QUIET = '/switch-fixture';
export const A_AMOUNT = /\+\s*[¥￥]\s*61\.01/;
export const B_AMOUNT = /\+\s*[¥￥]\s*72\.02/;

/** Every pending boundary is released even when an early red assertion stops the test. */
export function deferred<T>(fallback: T) {
  const pending = Promise.withResolvers<T>();
  releases.push(() => pending.resolve(fallback));
  return pending;
}

/** Flush the resolved transport and React Query's scheduled observer notification. */
export async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const release of releases.splice(0)) release();
  });
  for (const dispose of disposals.splice(0)) dispose();
  for (const client of clients) client.clear();
  clients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

/** Real SDK, fake native boundary; the account is captured when each token call starts. */
export function switchBridge(firstToken?: Promise<H5Token>) {
  let account = 'A';
  let tokenCalls = 0;
  const native = installBridge(['app.getEnv', 'auth.getH5Token'], async (request) => {
    if (request.method === 'app.getEnv')
      return { id: request.id, code: 0, msg: '', data: NATIVE_ENV };
    tokenCalls += 1;
    const data =
      tokenCalls === 1 && firstToken !== undefined ? await firstToken : token('standard', account);
    return { id: request.id, code: 0, msg: '', data };
  });
  const subscribe = native.transport.subscribe.bind(native.transport);
  const active = new Set<(event: BridgeEvent) => void>();
  vi.spyOn(native.transport, 'subscribe').mockImplementation((listener) => {
    active.add(listener);
    const off = subscribe(listener);
    const unsubscribe = () => {
      active.delete(listener);
      off();
    };
    disposals.push(unsubscribe);
    return unsubscribe;
  });
  return {
    ...native,
    active: () => active.size,
    listeners: () => [...active],
    tokenCalls: () => tokenCalls,
    async change(loggedIn = true, nextAccount = 'B') {
      account = nextAccount;
      await act(async () => {
        native.emit({ event: 'auth.changed', data: { logged_in: loggedIn } });
      });
    },
  };
}

/** Reuse the existing HTTP fixture; only fetch is replaced, never the application API. */
export function switchServer(
  handler: (request: Request, count: number) => Response | Promise<Response>,
) {
  const http = server((_url, count) => handler(http.requests[count - 1]!, count));
  vi.stubGlobal('fetch', http.fetch);
  return http;
}

/**
 * Mount the real shell and real lazy pages. The wrapper only observes their providers.
 * A quiet test route lets us remove every business page without unmounting the shell.
 */
export async function mountShell(path = QUIET) {
  buildEnv();
  let observed: { api: H5ApiClient | null; client: QueryClient } | undefined;
  function observe(Component: ComponentType): ComponentType {
    return function ObservedPage() {
      const api = useApi();
      const client = useQueryClient();
      observed = { api, client };
      clients.add(client);
      return createElement(Component);
    };
  }
  const routes = appRoutes.createAppRoutes().map((route) => ({
    ...route,
    lazy: async () => ({ Component: observe((await route.lazy()).Component) }),
  }));
  routes.push({ path: QUIET, lazy: async () => ({ Component: observe(QuietPage) }) });
  vi.spyOn(appRoutes, 'createAppRoutes').mockReturnValue(routes);
  window.history.replaceState(null, '', path);
  const view = render(createAppShell());
  await waitFor(() => expect(observed).toBeDefined());
  expect(observed!.api, 'real createAppApi must be available inside the shell').not.toBeNull();
  return { ...view, api: observed!.api!, client: observed!.client };
}

function QuietPage() {
  return createElement('p', null, 'switch-quiet-page');
}

export async function navigate(path: string) {
  await act(async () => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/** Observe every committed DOM removal as well as the final screen, to catch cache flashes. */
export function watchForOldData(container: HTMLElement) {
  const leaks: string[] = [];
  const inspect = (node: Node) => {
    if (A_AMOUNT.test(node.textContent ?? '')) leaks.push(node.textContent ?? '');
  };
  const observer = new MutationObserver((records) => {
    inspect(container);
    for (const record of records) {
      if (record.oldValue !== null && A_AMOUNT.test(record.oldValue)) leaks.push(record.oldValue);
      for (const node of record.addedNodes) inspect(node);
      for (const node of record.removedNodes) inspect(node);
    }
  });
  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
  });
  disposals.push(() => observer.disconnect());
  return leaks;
}
