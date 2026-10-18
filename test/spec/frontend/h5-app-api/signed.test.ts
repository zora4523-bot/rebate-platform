// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { ENV, nativeBridge, requiredText, envelope, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-01q-SIGNED#1] 契约所有 x-signed 操作明确拒绝，不带 H5 令牌直发或偷偷走原生代发', async () => {
  // Independent oracle from OpenAPI's path/method indentation, not an implementation list.
  const operations: { path: string; method: string }[] = [];
  let path = '';
  let method = '';
  for (const line of requiredText('contracts/openapi.yaml').split('\n')) {
    const pathMatch = /^  (\/[^:]+):$/.exec(line);
    const methodMatch = /^    (get|post|put|patch|delete|head|options):$/.exec(line);
    if (pathMatch) path = pathMatch[1]!;
    if (methodMatch) method = methodMatch[1]!.toUpperCase();
    if (/^      x-signed: true$/.test(line)) operations.push({ path, method });
  }
  expect(operations.length).toBeGreaterThan(0);
  expect(operations).toContainEqual({ path: '/v1/withdrawals', method: 'POST' });
  const native = nativeBridge(['app.getEnv', 'auth.getH5Token', 'net.signedRequest']);
  // Successful replies ensure accidental fetch cannot pass merely by failing the fake transport.
  const wire = transport(...operations.map(() => ({ body: envelope({}) })));
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  // Metadata enumerates heterogeneous request bodies; bypass TS only at this contract boundary.
  const request = client!.request as (
    method: string,
    path: string,
    options: object,
  ) => Promise<unknown>;
  for (const operation of operations) {
    await expect(
      Promise.resolve().then(() =>
        request.call(client, operation.method, operation.path, { body: {} }),
      ),
      `${operation.method} ${operation.path}`,
    ).rejects.toThrow(/signed|signature/i);
  }
  expect(wire.fetch).not.toHaveBeenCalled();
  expect(native.postMessage.mock.calls.map(([message]) => message.method)).not.toContain(
    'net.signedRequest',
  );
});

it('[AC-F1-01q-SIGNED#2] 非签名 POST 仍能发送，签名拦截不能扩大为禁止全部写请求', async () => {
  const native = nativeBridge();
  const wire = transport({ body: envelope({ tpwd: 'fixture-tpwd' }) });
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  expect(
    await client!.request('POST', '/v1/share-pages/{link_id}/tpwd', {
      params: { path: { link_id: 'fixture-link' } },
      body: { ticket: 'fixture-ticket' },
    }),
  ).toEqual({ tpwd: 'fixture-tpwd' });
  expect(wire.requests).toHaveLength(1);
  expect(wire.requests[0]!.method).toBe('POST');
  expect(wire.requests[0]!.url).toBe(`${ENV.apiBaseUrl}/v1/share-pages/fixture-link/tpwd`);
  expect(await wire.requests[0]!.json()).toEqual({ ticket: 'fixture-ticket' });
  expect(wire.requests[0]!.headers.has('X-Sign')).toBe(false);
});

it('[AC-F1-01q-SIGNED#3] 同路径的非签名 GET 仍能读取，签名拦截必须区分请求方法', async () => {
  const native = nativeBridge(['app.getEnv', 'auth.getH5Token', 'net.signedRequest']);
  const cases = [
    { path: '/v1/withdrawals', data: { items: [], next_cursor: null } },
    { path: '/v1/me/payout-account', data: {} },
    { path: '/v1/me/deletion', data: null },
  ] as const;
  const wire = transport(...cases.map(({ data }) => ({ body: envelope(data) })));
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  for (const { path, data } of cases) {
    expect(await client!.request('GET', path, {}), path).toEqual(data);
  }
  expect(wire.requests).toHaveLength(cases.length);
  for (const [index, { path }] of cases.entries()) {
    const request = wire.requests[index]!;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`${ENV.apiBaseUrl}${path}`);
    expect(request.headers.get('Authorization')).toBe('Bearer fixture-memory-token-1');
    expect(request.headers.has('X-Sign')).toBe(false);
  }
  expect(native.postMessage.mock.calls.map(([message]) => message.method)).not.toContain(
    'net.signedRequest',
  );
});
