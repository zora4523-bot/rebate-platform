// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  deferred,
  mountShell,
  reply,
  settle,
  switchBridge,
  switchServer,
  token,
} from './switch-helpers.ts';

it('[AC-F1-01s-TOKEN#1] 壳层换号后同一个应用 API 客户端重新取令牌，不复用 A 的令牌', async () => {
  const native = switchBridge();
  const http = switchServer(() => reply({ id: 'fixture-user' }));
  const { api } = await mountShell();
  await api.request('GET', '/v1/me', {});
  await api.request('GET', '/v1/me', {});
  expect(native.tokenCalls()).toBe(1);
  expect(http.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer h5-test-A',
    'Bearer h5-test-A',
  ]);

  await native.change();
  await api.request('GET', '/v1/me', {});
  expect(native.tokenCalls()).toBe(2);
  expect(http.requests[2]!.headers.get('Authorization')).toBe('Bearer h5-test-B');
});

it('[AC-F1-01s-TOKEN#2] 换号前在途取令牌晚到时，等待者和后续请求都不得使用旧令牌', async () => {
  const oldToken = deferred(token('standard', 'A'));
  const native = switchBridge(oldToken.promise);
  const http = switchServer(() => reply({ id: 'fixture-user' }));
  const { api, client } = await mountShell();
  const oldKey = ['switch-pending-token-private'];
  // This query began in A's session. Even if token acquisition resumes with B's token,
  // its result must be discarded or cancelled instead of repopulating the cleared cache.
  // Attach a rejection handler immediately so cancellation cannot leak a rejection.
  const waiting = client
    .fetchQuery({ queryKey: oldKey, queryFn: () => api.request('GET', '/v1/me', {}) })
    .then(
      () => 'fulfilled',
      () => 'cancelled',
    );
  await waitFor(() => expect(native.tokenCalls()).toBe(1));
  expect(http.requests).toHaveLength(0);
  await native.change();
  await settle(oldToken, token('standard', 'A'));
  await waiting;
  await api.request('GET', '/v1/me', {});

  expect(client.getQueryData(oldKey)).toBeUndefined();
  expect(client.getQueryCache().find({ queryKey: oldKey, exact: true })).toBeUndefined();
  expect(native.tokenCalls()).toBe(2);
  expect(http.requests.length).toBeGreaterThan(0);
  expect(
    http.requests.every((request) => request.headers.get('Authorization') === 'Bearer h5-test-B'),
  ).toBe(true);
});

it('[AC-F1-01s-TOKEN#3] 新账号取令牌不等待 A 的在途取令牌，旧结果也不能覆盖 B', async () => {
  const oldToken = deferred(token('standard', 'A'));
  const native = switchBridge(oldToken.promise);
  const http = switchServer(() => reply({ id: 'fixture-user' }));
  const { api } = await mountShell();
  const oldRequest = api.request('GET', '/v1/me', {}).then(
    () => 'fulfilled',
    () => 'cancelled',
  );
  await waitFor(() => expect(native.tokenCalls()).toBe(1));
  await native.change();
  const newRequest = api.request('GET', '/v1/me', {}).then(
    () => 'fulfilled',
    () => 'cancelled',
  );
  // Do not wait 10 s here: the native timeout is shorter. Old native work is released in finally.
  try {
    await waitFor(() => expect(native.tokenCalls()).toBe(2), { timeout: 1000 });
    expect(await newRequest).toBe('fulfilled');
    expect(http.requests[0]!.headers.get('Authorization')).toBe('Bearer h5-test-B');
  } finally {
    await settle(oldToken, token('standard', 'A'));
    await Promise.all([oldRequest, newRequest]);
  }
  await api.request('GET', '/v1/me', {});
  expect(native.tokenCalls()).toBe(2);
  expect(
    http.requests.every((request) => request.headers.get('Authorization') === 'Bearer h5-test-B'),
  ).toBe(true);
});
