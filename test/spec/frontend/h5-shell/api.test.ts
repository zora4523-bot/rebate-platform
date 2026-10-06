import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { BASE_URL, HEALTH, commonHeaders, envelope, errorCatalog, transport } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

it('[AC-F1-01c-API#1] openapi 类型客户端返回 data，不泄漏成功外壳', async () => {
  const wire = transport({ body: envelope(HEALTH) });
  const client = createApiClient({ baseUrl: BASE_URL, headers: commonHeaders, fetch: wire.fetch });
  const result = await client.request('GET', '/healthz', {});
  expectTypeOf(result).toEqualTypeOf<{
    status: 'ok';
    entry: 'api' | 'stream' | 'admin' | 'worker' | 'payout';
    now: string;
  }>();
  expect(result).toEqual(HEALTH);
  expect(result).not.toHaveProperty('code');
  expect(wire.requests[0]?.url).toBe(`${BASE_URL}/healthz`);
  expect(wire.requests[0]?.method).toBe('GET');
});

it.each([null, false, 0, '', [], { nested: { code: 10001, data: 'keep' } }])(
  '[AC-F1-01c-API#2] 不按 truthiness 或嵌套 code 改写 data：%j',
  async (data) => {
    const wire = transport({ body: envelope(data) });
    const client = createApiClient({
      baseUrl: BASE_URL,
      headers: commonHeaders,
      fetch: wire.fetch,
    });
    expect(await client.request('GET', '/healthz', {})).toEqual(data);
  },
);

it('[AC-F1-01c-API#3] 所有已分配错误码的 action 均来自契约，HTTP 200 也须抛错', async () => {
  const catalog = errorCatalog();
  expect(catalog.length).toBeGreaterThan(0);
  const client = createApiClient({
    baseUrl: BASE_URL,
    headers: commonHeaders,
    fetch: transport(
      ...catalog.map(({ code }) => ({
        body: envelope({ reason: 'fixture-reason' }, code, `fixture-${code}`),
      })),
    ).fetch,
  });
  for (const { code, action } of catalog) {
    const pending = client.request('GET', '/healthz', {});
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({
      code,
      msg: `fixture-${code}`,
      data: { reason: 'fixture-reason' },
      action,
    });
  }
});

it.each([401, 403, 422, 429, 500])(
  '[AC-F1-01c-API#4] HTTP %i 的 JSON 错误仍按业务 code 解包',
  async (status) => {
    const action = errorCatalog().find((item) => item.code === 10403)!.action;
    const wire = transport({ status, body: envelope({ reason: 'h5_read_only' }, 10403, 'denied') });
    const client = createApiClient({
      baseUrl: BASE_URL,
      headers: commonHeaders,
      fetch: wire.fetch,
    });
    await expect(client.request('GET', '/healthz', {})).rejects.toMatchObject({
      code: 10403,
      msg: 'denied',
      data: { reason: 'h5_read_only' },
      action,
    });
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  },
);

it('[AC-F1-01c-API#5] 未知码保留原始错误，采用公共错误兜底且不自动重放', async () => {
  const action = errorCatalog().find((item) => item.code === 50001)!.action;
  const wire = transport({ body: envelope({ reason: 'future' }, 59999, 'future-error') });
  const client = createApiClient({ baseUrl: BASE_URL, headers: commonHeaders, fetch: wire.fetch });
  const pending = client.request('GET', '/healthz', {});
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  await expect(pending).rejects.toMatchObject({
    code: 59999,
    msg: 'future-error',
    data: { reason: 'future' },
    action,
  });
  expect(wire.fetch).toHaveBeenCalledTimes(1);
});

it('[AC-F1-01c-API#6] 公共请求头逐请求从注入函数取，不臆造品牌或平台', async () => {
  const wire = transport({ body: envelope(HEALTH) }, { body: envelope(HEALTH) });
  let brand = 'first_brand';
  const headers = vi.fn(async () => ({ ...commonHeaders(), 'X-App-Id': brand }));
  const client = createApiClient({ baseUrl: BASE_URL, headers, fetch: wire.fetch });
  await client.request('GET', '/healthz', { headers: { 'X-Trace-Id': 'fixture-trace-1' } });
  brand = 'second_brand';
  await client.request('GET', '/healthz', {});
  expect(headers).toHaveBeenCalledTimes(2);
  expect(wire.requests.map((request) => request.headers.get('X-App-Id'))).toEqual([
    'first_brand',
    'second_brand',
  ]);
  expect(wire.requests[0]?.headers.get('X-Platform')).toBe('h5');
  expect(wire.requests[0]?.headers.get('X-Trace-Id')).toBe('fixture-trace-1');
  expect(wire.requests[0]?.headers.has('X-Channel')).toBe(false);
  expect(wire.requests[0]?.headers.has('X-Device-Id')).toBe(false);
});

it('[AC-F1-01c-API#7] landing 风格客户端即使页面有桥也不主动取令牌', async () => {
  const postMessage = vi.fn();
  vi.stubGlobal('__REBATE_BRIDGE__', { version: 1, methods: ['auth.getH5Token'], postMessage });
  const wire = transport({ body: envelope(HEALTH) });
  const client = createApiClient({ baseUrl: BASE_URL, headers: commonHeaders, fetch: wire.fetch });
  expect(await client.request('GET', '/healthz', {})).toEqual(HEALTH);
  expect(wire.requests[0]?.headers.has('Authorization')).toBe(false);
  expect(postMessage).not.toHaveBeenCalled();
});

it('[AC-F1-01c-API#8] 类型与序列化均保留契约路径参数及 JSON 请求体', async () => {
  const wire = transport({ body: envelope({ tpwd: 'fixture-tpwd' }) });
  const client = createApiClient({ baseUrl: BASE_URL, headers: commonHeaders, fetch: wire.fetch });
  await client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
    params: { path: { link_id: 'fixture-link' } },
    body: { ticket: 'fixture-ticket' },
  });
  expect(wire.requests[0]?.url).toBe(`${BASE_URL}/v1/share-pages/fixture-link/tpwd`);
  expect(wire.requests[0]?.headers.get('Content-Type')).toContain('application/json');
  expect(await wire.requests[0]!.json()).toEqual({ ticket: 'fixture-ticket' });
  // This declaration is checked by tsc but never invokes invalid requests.
  function contractTypeChecks() {
    // @ts-expect-error nonexistent contract path
    void client.request('GET', '/v1/not-a-contract-route', {});
    // @ts-expect-error POST is not allowed for /healthz
    void client.request('POST', '/healthz', {});
    void client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
      params: { path: { link_id: 'x' } },
      // @ts-expect-error ticket must be a string
      body: { ticket: 123 },
    });
  }
  void contractTypeChecks;
});

it('[AC-F1-01c-API#9] 传输失败原样拒绝，不当成成功或重发写请求', async () => {
  const failure = new Error('fixture network failure');
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
  const client = createApiClient({ baseUrl: BASE_URL, headers: commonHeaders, fetch });
  await expect(
    client.request('POST', '/v1/share-pages/{link_id}/tpwd', {
      params: { path: { link_id: 'fixture-link' } },
      body: { ticket: 'fixture-ticket' },
    }),
  ).rejects.toBe(failure);
  expect(fetch).toHaveBeenCalledTimes(1);
});
