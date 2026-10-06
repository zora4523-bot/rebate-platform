import { expect, it, vi } from 'vitest';
import {
  AdminApiError,
  createDataProvider,
} from '../../../../apps/admin/src/providers/data/index.ts';
import {
  ADMIN_ONE,
  API_ERRORS,
  BASE_URL,
  RATE_LIMITED,
  TRACE_ID,
  jsonResponse,
} from './fixtures.ts';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected request to reject');
    },
    (error: unknown) => error,
  );
}

for (const envelope of API_ERRORS) {
  for (const httpStatus of [200, envelope.code === 10001 ? 401 : 403]) {
    it(`[AC-F1-06g-ERROR#1] HTTP ${httpStatus} / ${envelope.data.reason} 保留错误并统一处理一次`, async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        jsonResponse(envelope, httpStatus, {
          'X-Trace-Id': 'header-trace-distinct-from-envelope',
        }),
      );
      const onError = vi.fn();
      const provider = createDataProvider({
        baseUrl: BASE_URL,
        fetch,
        getToken: () => 'token',
        onError,
      });
      const error = await rejection(provider.getList({ resource: 'admins' }));
      expect(error).toBeInstanceOf(AdminApiError);
      expect(error).toMatchObject({
        kind: 'api',
        code: envelope.code,
        msg: envelope.msg,
        data: envelope.data,
        httpStatus,
        traceId: 'header-trace-distinct-from-envelope',
      });
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
}

for (const operation of ['getOne', 'custom'] as const) {
  it(`[AC-F1-06g-ERROR#2] ${operation} 不绕过服务端权限错误处理`, async () => {
    const denied = API_ERRORS[0]!;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(denied, 403));
    const onError = vi.fn();
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => 'token',
      onError,
    });
    const result =
      operation === 'getOne'
        ? provider.getOne({ resource: 'admins', id: ADMIN_ONE.data.admin_id })
        : provider.custom({ url: '/admin/v1/me/permissions', method: 'get' });
    const error = await rejection(result);
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({
      code: 10403,
      data: { reason: 'admin_permission_denied' },
      httpStatus: 403,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

for (const [header, expected] of [
  [undefined, 5],
  ['17', 17],
] as const) {
  it(`[AC-F1-06g-ERROR#3] 42901 Retry-After=${header ?? '缺省'} 转为秒且不自动重发`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(RATE_LIMITED, 429, header === undefined ? {} : { 'Retry-After': header }),
    );
    const onError = vi.fn();
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => null,
      onError,
    });
    const error = await rejection(provider.getList({ resource: 'admins' }));
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({
      code: 42901,
      msg: RATE_LIMITED.msg,
      httpStatus: 429,
      retryAfterSeconds: expected,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

it('[AC-F1-06g-ERROR#4] 网络拒绝统一变成 code=-1 的 network 错误', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new TypeError('Failed to fetch');
  });
  const onError = vi.fn();
  const provider = createDataProvider({ baseUrl: BASE_URL, fetch, getToken: () => null, onError });
  const error = await rejection(provider.getList({ resource: 'admins' }));
  expect(error).toBeInstanceOf(AdminApiError);
  expect(error).toMatchObject({
    code: -1,
    kind: 'network',
    httpStatus: 0,
    msg: expect.any(String),
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(fetch).toHaveBeenCalledTimes(1);
});

for (const status of [200, 502]) {
  it(`[AC-F1-06g-ERROR#5] HTTP ${status} 非 JSON 统一变成 code=-2 的 parse 错误`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('<html>gateway</html>', {
          status,
          headers: { 'Content-Type': 'text/html', 'X-Trace-Id': TRACE_ID },
        }),
    );
    const onError = vi.fn();
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => null,
      onError,
    });
    const error = await rejection(provider.getList({ resource: 'admins' }));
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({ code: -2, kind: 'parse', httpStatus: status, traceId: TRACE_ID });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

for (const status of [201, 403, 500]) {
  it(`[AC-F1-06g-ERROR#6] code=0 但 HTTP ${status} 不能当成功`, async () => {
    // Deliberately inconsistent server response exercises the HTTP AND code success condition.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADMIN_ONE, status));
    const onError = vi.fn();
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => null,
      onError,
    });
    const error = await rejection(
      provider.getOne({ resource: 'admins', id: ADMIN_ONE.data.admin_id }),
    );
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({ httpStatus: status });
    expect((error as AdminApiError).code).not.toBe(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });
}

it('[AC-F1-06g-ERROR#7] 字符串 "0" 不能冒充成功码', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ ...ADMIN_ONE, code: '0' }),
  );
  const onError = vi.fn();
  const provider = createDataProvider({ baseUrl: BASE_URL, fetch, getToken: () => null, onError });
  const error = await rejection(
    provider.getOne({ resource: 'admins', id: ADMIN_ONE.data.admin_id }),
  );
  expect(error).toBeInstanceOf(AdminApiError);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});
