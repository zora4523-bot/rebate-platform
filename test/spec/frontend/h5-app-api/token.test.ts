// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { ENV, nativeBridge, envelope, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01q-TOKEN#1] 登录读接口使用 SDK 令牌管理器，令牌只在内存复用且不进入存储或 URL', async () => {
  const native = nativeBridge();
  const managed = vi.spyOn(native.manager, 'request');
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const cookie = vi.spyOn(Document.prototype, 'cookie', 'set');
  const initialUrl = window.location.href;
  const wire = transport({ body: envelope({ id: 'me' }) }, { body: envelope({ id: 'me' }) });
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  expect(await client!.request('GET', '/v1/me', {})).toEqual({ id: 'me' });
  expect(await client!.request('GET', '/v1/me', {})).toEqual({ id: 'me' });
  expect(native.bridge.createH5TokenManager).toHaveBeenCalledTimes(1);
  expect(managed.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET']);
  expect(native.tokenCalls()).toBe(1);
  expect(wire.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer fixture-memory-token-1',
    'Bearer fixture-memory-token-1',
  ]);
  expect(storage).not.toHaveBeenCalled();
  expect(cookie).not.toHaveBeenCalled();
  expect(window.location.href).toBe(initialUrl);
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  for (const request of wire.requests) {
    expect(request.url).toBe(`${ENV.apiBaseUrl}/v1/me`);
    expect(await request.text()).toBe('');
  }
});

it('[AC-F1-01q-TOKEN#2] 10002 经管理器只续取一次并重发同一个读请求', async () => {
  const native = nativeBridge();
  const wire = transport(
    { status: 401, body: envelope(null, 10002, 'expired') },
    { body: envelope({ id: 'me' }) },
  );
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  expect(await client!.request('GET', '/v1/me', {})).toEqual({ id: 'me' });
  expect(native.tokenCalls()).toBe(2);
  expect(wire.requests.map((request) => [request.method, request.url])).toEqual([
    ['GET', `${ENV.apiBaseUrl}/v1/me`],
    ['GET', `${ENV.apiBaseUrl}/v1/me`],
  ]);
  expect(wire.requests.map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer fixture-memory-token-1',
    'Bearer fixture-memory-token-2',
  ]);
});

it('[AC-F1-01q-TOKEN#3] 续取后仍为 10002 时结束，不无限续取或重放', async () => {
  const native = nativeBridge();
  const wire = transport(
    { status: 401, body: envelope(null, 10002, 'expired') },
    { status: 401, body: envelope(null, 10002, 'expired-again') },
  );
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  await expect(client!.request('GET', '/v1/me', {})).rejects.toMatchObject({ code: 10002 });
  expect(native.tokenCalls()).toBe(2);
  expect(wire.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01q-TOKEN#4] 缺少取令牌能力时不匿名发送需要登录的请求', async () => {
  const native = nativeBridge(['app.getEnv']);
  const wire = transport();
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  await expect(client!.request('GET', '/v1/me', {})).rejects.toMatchObject({ code: 90001 });
  expect(native.tokenCalls()).toBe(0);
  expect(wire.fetch).not.toHaveBeenCalled();
});
