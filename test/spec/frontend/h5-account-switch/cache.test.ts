// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
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
  watchForOldData,
} from './switch-helpers.ts';

it('[AC-F1-01s-CACHE#1] 已显示 A 流水时先取消再清空壳层缓存，立即撤下 A，随后只显示 B', async () => {
  const native = switchBridge();
  const next = deferred(reply(list([posting({ amount_fen: 7202 })])));
  switchServer((request) =>
    request.headers.get('Authorization') === 'Bearer h5-test-A'
      ? reply(list([posting({ amount_fen: 6101 })]))
      : next.promise,
  );
  const view = await mountShell('/ledger');
  await screen.findByText(A_AMOUNT);
  // clear() must also remove inactive queries and mutations, not just refresh the visible ledger.
  view.client.setQueryData(['switch-inactive-private'], { owner: 'A' });
  view.client.getMutationCache().build(view.client, { mutationKey: ['switch-private-mutation'] });
  const cancel = vi.spyOn(view.client, 'cancelQueries');
  const clear = vi.spyOn(view.client, 'clear');

  await native.change();
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledTimes(1);
  expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(clear.mock.invocationCallOrder[0]!);
  expect(view.client.getQueryData(['switch-inactive-private'])).toBeUndefined();
  expect(view.client.getMutationCache().getAll()).toEqual([]);
  const leaks = watchForOldData(view.container);
  await settle(next, reply(list([posting({ amount_fen: 7202 })])));
  await screen.findByText(B_AMOUNT);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(leaks).toEqual([]);
  expect(native.tokenCalls()).toBe(2);
});

it('[AC-F1-01s-CACHE#2] A 的流水响应晚于 B 返回时，不覆盖 B 的页面或新缓存', async () => {
  const native = switchBridge();
  const old = deferred(reply(list([posting({ amount_fen: 6101 })])));
  const http = switchServer((request) =>
    request.headers.get('Authorization') === 'Bearer h5-test-A'
      ? old.promise
      : reply(list([posting({ amount_fen: 7202 })])),
  );
  const view = await mountShell('/ledger');
  await waitFor(() => expect(http.requests).toHaveLength(1));
  const leaks = watchForOldData(view.container);
  await native.change();
  // Positive B result makes this red even if an implementation merely drops all responses.
  await waitFor(() => expect(screen.queryByText(B_AMOUNT)).not.toBeNull());
  await settle(old, reply(list([posting({ amount_fen: 6101 })])));
  expect(view.container.textContent).toMatch(B_AMOUNT);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(leaks).toEqual([]);
  const cached = JSON.stringify(
    view.client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
  expect(cached).not.toContain('6101');
  expect(http.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer h5-test-A',
    'Bearer h5-test-B',
  ]);
});

it('[AC-F1-01s-CACHE#3] 离开流水页后换号，回来时不得短暂命中 A 的缓存', async () => {
  const native = switchBridge();
  const next = deferred(reply(list([posting({ amount_fen: 7202 })])));
  const http = switchServer((request) =>
    request.headers.get('Authorization') === 'Bearer h5-test-A'
      ? reply(list([posting({ amount_fen: 6101 })]))
      : next.promise,
  );
  const view = await mountShell('/ledger');
  await screen.findByText(A_AMOUNT);
  await navigate(QUIET);
  await screen.findByText('switch-quiet-page');
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .some((query) => query.state.data !== undefined),
  ).toBe(true);
  const requestsBefore = http.requests.length;
  await native.change();
  expect(view.client.getQueryCache().getAll()).toEqual([]);
  expect(http.requests).toHaveLength(requestsBefore);

  const leaks = watchForOldData(view.container);
  await navigate('/ledger');
  await waitFor(() => expect(http.requests.length).toBeGreaterThan(requestsBefore));
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  await settle(next, reply(list([posting({ amount_fen: 7202 })])));
  await screen.findByText(B_AMOUNT);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
  expect(leaks).toEqual([]);
  expect(http.requests.at(-1)!.headers.get('Authorization')).toBe('Bearer h5-test-B');
});

it('[AC-F1-01s-CACHE#4] 换号后 B 尚未返回时到达的 A 响应也不能重新填充页面或缓存', async () => {
  const native = switchBridge();
  const old = deferred(reply(list([posting({ amount_fen: 6101 })])));
  const next = deferred(reply(list([posting({ amount_fen: 7202 })])));
  const http = switchServer((request) =>
    request.headers.get('Authorization') === 'Bearer h5-test-A' ? old.promise : next.promise,
  );
  const view = await mountShell('/ledger');
  await waitFor(() => expect(http.requests).toHaveLength(1));
  const leaks = watchForOldData(view.container);
  await native.change();
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
  expect(leaks).toEqual([]);
  await settle(next, reply(list([posting({ amount_fen: 7202 })])));
  await screen.findByText(B_AMOUNT);
  expect(view.container.textContent).not.toMatch(A_AMOUNT);
});
