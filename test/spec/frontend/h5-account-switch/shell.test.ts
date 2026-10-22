// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { articles, summaries } from '../h5-help/fixtures.ts';
import {
  A_AMOUNT,
  B_AMOUNT,
  QUIET,
  deferred,
  list,
  mountShell,
  navigate,
  posting,
  reply,
  settle,
  switchBridge,
  switchServer,
} from './switch-helpers.ts';

it('[AC-F1-01s-SHELL#1] 无业务页面时仍有唯一壳层订阅，页面卸载和路由切换不注销它', async () => {
  const native = switchBridge();
  switchServer(() => reply(list([posting({ amount_fen: 6101 })])));
  const view = await mountShell();
  expect(native.active()).toBe(1);
  const shellListener = native.listeners()[0]!;
  await navigate('/ledger');
  await screen.findByText(A_AMOUNT);
  expect(native.listeners()).toContain(shellListener);
  await navigate(QUIET);
  await screen.findByText('switch-quiet-page');
  expect(native.active()).toBe(1);
  expect(native.listeners()).toContain(shellListener);
  const clear = vi.spyOn(view.client, 'clear');
  await native.change();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(native.active()).toBe(1);
});

it('[AC-F1-01s-SHELL#2] find-order 路由下壳层也清理账号数据，卸载后退订且事件不再触发清理', async () => {
  const native = switchBridge();
  switchServer(() => reply({ items: [], next_cursor: null }));
  // This revision has a placeholder at /find-order; no account-switch logic is added to it.
  const view = await mountShell('/find-order');
  view.client.setQueryData(['switch-find-order-private'], { owner: 'A' });
  const cancel = vi.spyOn(view.client, 'cancelQueries');
  const clear = vi.spyOn(view.client, 'clear');
  await native.change();
  expect(view.client.getQueryData(['switch-find-order-private'])).toBeUndefined();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  // A page may also subscribe for its own local state; global cache cleanup still happens once.
  expect(native.active()).toBeGreaterThanOrEqual(1);

  view.unmount();
  expect(native.active()).toBe(0);
  cancel.mockClear();
  clear.mockClear();
  view.client.setQueryData(['switch-after-unmount'], 'untouched');
  await native.change(false);
  expect(cancel).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(view.client.getQueryData(['switch-after-unmount'])).toBe('untouched');
});

it('[AC-F1-01s-SHELL#3] 退出登录立即撤下 A 流水并清缓存，不自动取令牌或请求，重新登录可显示 B', async () => {
  const native = switchBridge();
  const http = switchServer((request) =>
    reply(
      list([
        posting({
          amount_fen: request.headers.get('Authorization') === 'Bearer h5-test-A' ? 6101 : 7202,
        }),
      ]),
    ),
  );
  const view = await mountShell('/ledger');
  await screen.findByText(A_AMOUNT);
  const requestCount = http.requests.length;
  const tokenCount = native.tokenCalls();
  const cancel = vi.spyOn(view.client, 'cancelQueries');
  const clear = vi.spyOn(view.client, 'clear');
  await native.change(false);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
      .filter((data) => data !== undefined),
  ).toEqual([]);
  // Cross a scheduled Query notification turn before checking the negative request assertion.
  await settle(deferred(undefined), undefined);
  expect(http.requests).toHaveLength(requestCount);
  expect(native.tokenCalls()).toBe(tokenCount);
  await native.change(true);
  await screen.findByText(B_AMOUNT);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(native.tokenCalls()).toBe(tokenCount + 1);
  expect(http.requests.at(-1)!.headers.get('Authorization')).toBe('Bearer h5-test-B');
});

it('[AC-F1-01s-SHELL#4] 退出时取消在途流水，迟到响应不复活 A，也不触发新请求', async () => {
  const native = switchBridge();
  const old = deferred(reply(list([posting({ amount_fen: 6101 })])));
  const http = switchServer(() => old.promise);
  const view = await mountShell('/ledger');
  await waitFor(() => expect(http.requests).toHaveLength(1));
  const cancel = vi.spyOn(view.client, 'cancelQueries');
  const clear = vi.spyOn(view.client, 'clear');
  await native.change(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  await settle(old, reply(list([posting({ amount_fen: 6101 })])));
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(
    JSON.stringify(
      view.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('6101');
  expect(http.requests).toHaveLength(1);
  expect(native.tokenCalls()).toBe(1);
});

it('[AC-F1-01s-SHELL#5] 无页面请求时退出也作废 API 令牌，事件本身不发请求', async () => {
  const native = switchBridge();
  const http = switchServer(() => reply({ id: 'fixture-user' }));
  const { api } = await mountShell();
  await api.request('GET', '/v1/me', {});
  await native.change(false);
  expect(http.requests).toHaveLength(1);
  expect(native.tokenCalls()).toBe(1);
  // An explicit caller is distinct from an automatic logout refetch. With no later login event
  // to invalidate on our behalf, this proves logged_in=false itself dropped the cached token.
  await api.request('GET', '/v1/me', {});
  expect(native.tokenCalls()).toBe(2);
  expect(http.requests[1]!.headers.get('Authorization')).toBe('Bearer h5-test-B');
});

it('[AC-F1-01s-SHELL#6] 退出清理账号缓存后，匿名帮助页仍能正常取数显示且不取令牌', async () => {
  const native = switchBridge();
  const http = switchServer((request) =>
    new URL(request.url).pathname === '/v1/articles'
      ? reply(summaries())
      : reply({ id: 'fixture-user' }),
  );
  const view = await mountShell();
  await view.api.request('GET', '/v1/me', {});
  view.client.setQueryData(['switch-logout-private'], { owner: 'A' });

  await native.change(false);
  expect(view.client.getQueryData(['switch-logout-private'])).toBeUndefined();
  await settle(deferred(undefined), undefined);
  expect(http.requests).toHaveLength(1);
  expect(native.tokenCalls()).toBe(1);

  await navigate('/help');
  await waitFor(() => expect(screen.queryByText(articles[0]!.title)).not.toBeNull());
  expect(http.requests).toHaveLength(2);
  const request = http.requests[1]!;
  expect(new URL(request.url).pathname).toBe('/v1/articles');
  expect(new URL(request.url).searchParams.get('category')).toBe('help');
  expect(request.headers.has('Authorization')).toBe(false);
  expect(native.tokenCalls()).toBe(1);
  expect(view.client.getQueryData(['switch-logout-private'])).toBeUndefined();
});
