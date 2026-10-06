import { expect, it, vi } from 'vitest';
import {
  AdminApiError,
  createDataProvider,
} from '../../../../apps/admin/src/providers/data/index.ts';
import {
  ADMIN_ONE,
  ADMIN_PAGE,
  BASE_URL,
  FINANCE_ME,
  STEP_UP_REQUEST,
  STEP_UP_RESPONSE,
  jsonResponse,
  requestFrom,
} from './fixtures.ts';

for (const pagination of [
  { current: 3, pageSize: 17 },
  { currentPage: 3, pageSize: 17 },
  { current: 3, pageSize: 200 },
  { currentPage: 3, pageSize: 201 },
  { current: 3, pageSize: 1000 },
]) {
  it(`[AC-F1-06g-DATA#1] 分页 ${JSON.stringify(pagination)} 映射为页码且上限 200`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADMIN_PAGE));
    const onError = vi.fn();
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => null,
      onError,
    });
    const result = await provider.getList({ resource: 'admins', pagination });
    expect(result).toEqual({ data: ADMIN_PAGE.data.items, total: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = requestFrom(...fetch.mock.calls[0]!);
    const url = new URL(request.url);
    expect(url.origin).toBe(BASE_URL);
    expect(url.pathname).toBe('/admin/v1/admins');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '3',
      page_size: String(Math.min(pagination.pageSize, 200)),
    });
    expect(request.method).toBe('GET');
    expect(onError).not.toHaveBeenCalled();
  });
}

it('[AC-F1-06g-DATA#2] total 取服务端总数而非本页条数；空页也保留总数', async () => {
  // Pagination boundary: same contract envelope, no items on this requested page.
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ ...ADMIN_PAGE, data: { ...ADMIN_PAGE.data, items: [], total: 42 } }),
  );
  const provider = createDataProvider({
    baseUrl: BASE_URL,
    fetch,
    getToken: () => null,
    onError: vi.fn(),
  });
  expect(
    await provider.getList({ resource: 'admins', pagination: { currentPage: 4, pageSize: 20 } }),
  ).toEqual({ data: [], total: 42 });
});

it('[AC-F1-06g-DATA#3] getOne 解包契约记录，尾斜线不导致重复前缀', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADMIN_ONE));
  const provider = createDataProvider({
    baseUrl: `${BASE_URL}/`,
    fetch,
    getToken: () => 'admin-test-token',
    onError: vi.fn(),
  });
  expect(await provider.getOne({ resource: 'admins', id: ADMIN_ONE.data.admin_id })).toEqual({
    data: ADMIN_ONE.data,
  });
  const request = requestFrom(...fetch.mock.calls[0]!);
  expect(request.url).toBe(`${BASE_URL}/admin/v1/admins/${ADMIN_ONE.data.admin_id}`);
  expect(request.method).toBe('GET');
  expect(request.headers.get('Authorization')).toBe('Bearer admin-test-token');
});

for (const method of ['getList', 'getOne', 'custom'] as const) {
  it(`[AC-F1-06g-DATA#4] ${method} 每次读取 token，二次验证令牌只随指定请求发送`, async () => {
    const envelope =
      method === 'getList' ? ADMIN_PAGE : method === 'getOne' ? ADMIN_ONE : FINANCE_ME;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(envelope));
    let token: string | null = 'first-token';
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => token,
      onError: vi.fn(),
    });
    const call = (meta: Record<string, string>) => {
      if (method === 'getList') return provider.getList({ resource: 'admins', meta });
      if (method === 'getOne')
        return provider.getOne({ resource: 'admins', id: ADMIN_ONE.data.admin_id, meta });
      return provider.custom({ url: '/admin/v1/me/permissions', method: 'get', meta });
    };
    await call({ stepUpToken: 'step-up-test-token' });
    token = 'second-token';
    await call({});
    token = null;
    await call({});
    expect(fetch).toHaveBeenCalledTimes(3);
    const requests = fetch.mock.calls.map((args) => requestFrom(...args));
    expect(requests.map((request) => request.headers.get('Authorization'))).toEqual([
      'Bearer first-token',
      'Bearer second-token',
      null,
    ]);
    expect(requests.map((request) => request.headers.get('X-Step-Up-Token'))).toEqual([
      'step-up-test-token',
      null,
      null,
    ]);
    for (const request of requests) {
      for (const header of [
        'X-App-Id',
        'X-Platform',
        'X-Device-Id',
        'X-App-Version',
        'X-Channel',
        'X-Timestamp',
        'X-Nonce',
        'X-Sign',
      ])
        expect(request.headers.has(header), header).toBe(false);
      expect(new URL(request.url).origin).toBe(BASE_URL);
      expect(new URL(request.url).pathname.startsWith('/admin/v1/')).toBe(true);
    }
  });
}

for (const url of ['/admin/v1/me/permissions', `${BASE_URL}/admin/v1/me/permissions`]) {
  it(`[AC-F1-06g-DATA#5] custom ${url} 支持 Refine URL 且只解一层 envelope`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(FINANCE_ME));
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => null,
      onError: vi.fn(),
    });
    expect(await provider.custom({ url, method: 'get' })).toEqual({ data: FINANCE_ME.data });
    const request = requestFrom(...fetch.mock.calls[0]!);
    expect(request.url).toBe(`${BASE_URL}/admin/v1/me/permissions`);
    expect(request.method).toBe('GET');
    expect(provider.getApiUrl()).toBe(`${BASE_URL}/admin/v1`);
  });
}

for (const url of [
  'https://elsewhere.example.test/admin/v1/me/permissions',
  '//elsewhere.example.test/admin/v1/me/permissions',
  `${BASE_URL}/api/v1/me`,
  '/admin/v10/me/permissions',
  '/admin/v1/../../api/v1/me',
  '/admin/v1/%2e%2e/%2e%2e/api/v1/me',
]) {
  it(`[AC-F1-06g-DATA#6] custom 拒绝越界地址 ${url}，不泄露 Bearer`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(FINANCE_ME));
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => 'private-token',
      onError: vi.fn(),
    });
    await expect(provider.custom({ url, method: 'get' })).rejects.toBeInstanceOf(AdminApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
}

for (const resource of ['../../api/v1/me', '%2e%2e/%2e%2e/api/v1/me']) {
  it(`[AC-F1-06g-DATA#7] getList 拒绝目录穿越 ${resource}`, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADMIN_PAGE));
    const provider = createDataProvider({
      baseUrl: BASE_URL,
      fetch,
      getToken: () => 'private-token',
      onError: vi.fn(),
    });
    await expect(provider.getList({ resource })).rejects.toBeInstanceOf(AdminApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
}

it('[AC-F1-06g-DATA#8] custom 发送契约 POST JSON；二次验证令牌不混入请求体', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(STEP_UP_RESPONSE));
  const provider = createDataProvider({
    baseUrl: BASE_URL,
    fetch,
    getToken: () => 'admin-token',
    onError: vi.fn(),
  });
  const result = await provider.custom({
    url: '/admin/v1/auth/step-up',
    method: 'post',
    payload: STEP_UP_REQUEST,
    meta: { stepUpToken: 'previous-step-up-token' },
  });
  expect(result).toEqual({ data: STEP_UP_RESPONSE.data });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = requestFrom(...fetch.mock.calls[0]!);
  expect(request.url).toBe(`${BASE_URL}/admin/v1/auth/step-up`);
  expect(request.method).toBe('POST');
  expect(request.headers.get('Content-Type')).toContain('application/json');
  expect(request.headers.get('Authorization')).toBe('Bearer admin-token');
  expect(request.headers.get('X-Step-Up-Token')).toBe('previous-step-up-token');
  expect(await request.json()).toEqual(STEP_UP_REQUEST);
});

it('[AC-F1-06g-DATA#9] custom query 序列化到契约列表 URL', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(ADMIN_PAGE));
  const provider = createDataProvider({
    baseUrl: BASE_URL,
    fetch,
    getToken: () => null,
    onError: vi.fn(),
  });
  expect(
    await provider.custom({
      url: '/admin/v1/admins',
      method: 'get',
      query: { page: 2, page_size: 20 },
    }),
  ).toEqual({ data: ADMIN_PAGE.data });
  const url = new URL(requestFrom(...fetch.mock.calls[0]!).url);
  expect(url.origin).toBe(BASE_URL);
  expect(url.pathname).toBe('/admin/v1/admins');
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', page_size: '20' });
});
