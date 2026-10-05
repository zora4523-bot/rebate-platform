import { afterEach, expect, it, vi } from 'vitest';
import { createH5TokenManager } from '@couli/bridge-sdk';
import { createApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { BASE_URL, HEALTH, commonHeaders, envelope, installTokenBridge, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01c-TOKEN#1] 每个请求经 manager.request，并携带它回调提供的 Bearer 令牌', async () => {
  const native = installTokenBridge('standard');
  const manager = createH5TokenManager();
  const request = vi.spyOn(manager, 'request');
  const wire = transport({ body: envelope(HEALTH) }, { body: envelope({ tpwd: 'fixture' }) });
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: manager,
    fetch: wire.fetch,
  });
  await client.request('GET', '/healthz', {});
  await client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
    params: { path: { link_id: 'fixture-link' } },
    body: { ticket: 'fixture-ticket' },
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual(['GET', 'POST']);
  expect(native.postMessage).toHaveBeenCalledTimes(1);
  expect(wire.requests.map((item) => item.headers.get('Authorization'))).toEqual([
    'Bearer fx.h5.tk-0',
    'Bearer fx.h5.tk-0',
  ]);
  expect(wire.requests.every((item) => !item.url.includes('fx.h5.tk'))).toBe(true);
});

it('[AC-F1-01c-TOKEN#2] HTTP 401 / code 10002 先交管理器刷新，保留 POST 请求体与幂等键重放一次', async () => {
  const native = installTokenBridge('standard', 'standard');
  const manager = createH5TokenManager();
  const wire = transport(
    { status: 401, body: envelope(null, 10002, 'expired') },
    { body: envelope({ tpwd: 'fixture-tpwd' }) },
  );
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: manager,
    fetch: wire.fetch,
  });
  const result = await client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
    params: { path: { link_id: 'fixture-link' } },
    body: { ticket: 'fixture-ticket' },
    headers: { 'Idempotency-Key': 'fixture-stable-key' },
  });
  expect(result).toEqual({ tpwd: 'fixture-tpwd' });
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  expect(wire.fetch).toHaveBeenCalledTimes(2);
  expect(wire.requests.map((item) => item.headers.get('Authorization'))).toEqual([
    'Bearer fx.h5.tk-0',
    'Bearer fx.h5.tk-1',
  ]);
  expect(
    wire.requests.map((item) => [item.method, item.url, item.headers.get('Idempotency-Key')]),
  ).toEqual([
    ['POST', `${BASE_URL}/v1/share-pages/fixture-link/tpwd`, 'fixture-stable-key'],
    ['POST', `${BASE_URL}/v1/share-pages/fixture-link/tpwd`, 'fixture-stable-key'],
  ]);
  expect(await Promise.all(wire.requests.map((item) => item.json()))).toEqual([
    { ticket: 'fixture-ticket' },
    { ticket: 'fixture-ticket' },
  ]);
});

it('[AC-F1-01c-TOKEN#3] 第二次仍过期才抛 ApiError，客户端不得额外刷新或重发', async () => {
  const native = installTokenBridge('standard', 'standard');
  const wire = transport(
    { status: 401, body: envelope(null, 10002, 'expired-1') },
    { status: 401, body: envelope(null, 10002, 'expired-2') },
  );
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: createH5TokenManager(),
    fetch: wire.fetch,
  });
  await expect(client.request('GET', '/healthz', {})).rejects.toMatchObject({
    code: 10002,
    msg: 'expired-2',
  });
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  expect(wire.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-F1-01c-TOKEN#4] read_only 可读，后续 POST 必须由管理器重新取令牌', async () => {
  const native = installTokenBridge('read_only', 'standard');
  const wire = transport({ body: envelope(HEALTH) }, { body: envelope({ tpwd: 'fixture' }) });
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: createH5TokenManager(),
    fetch: wire.fetch,
  });
  await client.request('GET', '/healthz', {});
  await client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
    params: { path: { link_id: 'fixture-link' } },
    body: { ticket: 'fixture-ticket' },
  });
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  expect(wire.requests.map((item) => item.headers.get('Authorization'))).toEqual([
    'Bearer fx.h5.tk-0',
    'Bearer fx.h5.tk-1',
  ]);
});

it('[AC-F1-01c-TOKEN#5] 10403/read_only 原样返回管理器以清缓存，本次不重发', async () => {
  const native = installTokenBridge('standard', 'standard');
  const wire = transport(
    { status: 403, body: envelope({ reason: 'h5_read_only' }, 10403, 'denied') },
    { body: envelope(HEALTH) },
  );
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: createH5TokenManager(),
    fetch: wire.fetch,
  });
  await expect(
    client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
      params: { path: { link_id: 'fixture-link' } },
      body: { ticket: 'fixture-ticket' },
    }),
  ).rejects.toMatchObject({ code: 10403, data: { reason: 'h5_read_only' } });
  expect(wire.fetch).toHaveBeenCalledTimes(1);
  expect(await client.request('GET', '/healthz', {})).toEqual(HEALTH);
  expect(native.postMessage).toHaveBeenCalledTimes(2);
  expect(wire.requests[1]?.headers.get('Authorization')).toBe('Bearer fx.h5.tk-1');
});

it('[AC-F1-01c-TOKEN#6] 管理器取令牌失败时请求不得发出', async () => {
  const manager = createH5TokenManager();
  const failure = new Error('fixture bridge unavailable');
  vi.spyOn(manager, 'request').mockRejectedValue(failure);
  const wire = transport();
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    tokenManager: manager,
    fetch: wire.fetch,
  });
  await expect(client.request('GET', '/healthz', {})).rejects.toBe(failure);
  expect(wire.fetch).not.toHaveBeenCalled();
});
