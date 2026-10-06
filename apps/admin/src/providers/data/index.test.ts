import { afterEach, expect, it, vi } from 'vitest';
import { AdminApiError, LOCAL_MESSAGES, createDataProvider } from './index.ts';

const BASE_URL = 'https://admin.example.test';
const PAGE = { code: 0, msg: 'ok', data: { items: [], total: 0, page: 1, page_size: 20 } };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function setup(fetchImpl: typeof globalThis.fetch) {
  const fetch = vi.fn<typeof globalThis.fetch>(fetchImpl);
  const onError = vi.fn<(error: AdminApiError) => void>();
  const provider = createDataProvider({ baseUrl: BASE_URL, fetch, getToken: () => 't', onError });
  return { fetch, onError, provider };
}

async function rejection(promise: Promise<unknown>): Promise<AdminApiError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('Expected request to reject');
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AdminApiError);
  return error as AdminApiError;
}

afterEach(() => {
  vi.useRealTimers();
});

it('body read failure after headers is a network error (-1), not parse', async () => {
  const reset = new TypeError('network connection was lost');
  const response = json(PAGE);
  vi.spyOn(response, 'text').mockRejectedValue(reset);
  const { onError, provider } = setup(async () => response);
  const error = await rejection(provider.getList({ resource: 'admins' }));
  expect(error).toMatchObject({
    kind: 'network',
    code: -1,
    msg: LOCAL_MESSAGES.network,
    httpStatus: 200,
    data: null,
  });
  expect(error.cause).toBe(reset);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});

it('invalid JSON is still a parse error (-2) with the cause kept', async () => {
  const { provider } = setup(async () => new Response('{', { status: 200 }));
  const error = await rejection(provider.getList({ resource: 'admins' }));
  expect(error).toMatchObject({ kind: 'parse', code: -2, msg: LOCAL_MESSAGES.parse });
  expect(error.cause).toBeInstanceOf(SyntaxError);
});

it('requests refuse redirects so the token cannot follow them', async () => {
  const { fetch, provider } = setup(async () => json(PAGE));
  await provider.getList({ resource: 'admins' });
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
});

it('a redirect rejection from fetch becomes a network error without the raw message', async () => {
  const { provider } = setup(async () => {
    throw new TypeError('unexpected redirect to https://elsewhere.example.test/x');
  });
  const error = await rejection(provider.getOne({ resource: 'admins', id: '1' }));
  expect(error).toMatchObject({ kind: 'network', code: -1, msg: LOCAL_MESSAGES.network });
  expect(error.data).toBeNull();
  expect(error.message).not.toContain('elsewhere');
});

it('a redirect response that slips through is refused as a network error', async () => {
  const { provider } = setup(
    async () => new Response(null, { status: 302, headers: { Location: '/elsewhere' } }),
  );
  const error = await rejection(provider.getOne({ resource: 'admins', id: '1' }));
  expect(error).toMatchObject({
    kind: 'network',
    code: -1,
    msg: LOCAL_MESSAGES.redirect,
    httpStatus: 302,
  });
});

const RATE_LIMITED = { code: 42901, msg: 'rate limited', data: null };

for (const [label, offsetMs, expected] of [
  ['past date', -60_000, 5],
  ['same instant', 0, 5],
  ['future date', 30_000, 30],
] as const) {
  it(`Retry-After as an HTTP date (${label}) → ${expected} seconds`, async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 7, 8, 0, 0), toFake: ['Date'] });
    const header = new Date(Date.now() + offsetMs).toUTCString();
    const { provider } = setup(async () => json(RATE_LIMITED, 429, { 'Retry-After': header }));
    const error = await rejection(provider.getList({ resource: 'admins' }));
    expect(error).toMatchObject({ code: 42901, retryAfterSeconds: expected });
  });
}

for (const mode of ['off', 'client'] as const) {
  it(`pagination mode '${mode}' is refused (-4) without sending`, async () => {
    const { fetch, onError, provider } = setup(async () => json(PAGE));
    const error = await rejection(
      provider.getList({ resource: 'admins', pagination: { mode, pageSize: 10 } }),
    );
    expect(error).toMatchObject({
      kind: 'request',
      code: -4,
      msg: LOCAL_MESSAGES.paginationModeUnsupported,
      data: { mode },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });
}

it("pagination mode 'server' pages as usual", async () => {
  const { fetch, provider } = setup(async () => json(PAGE));
  await provider.getList({
    resource: 'admins',
    pagination: { mode: 'server', currentPage: 2, pageSize: 10 },
  });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', page_size: '10' });
});

it('every local error msg is an admin_api.* key', async () => {
  const { provider } = setup(async () => json(PAGE));
  const errors = await Promise.all([
    rejection(provider.custom({ url: 'https://evil.example.test/admin/v1/x', method: 'get' })),
    rejection(provider.custom({ url: '/admin/v1/../x', method: 'get' })),
    rejection(provider.getList({ resource: 'admins?x' })),
    rejection(provider.getOne({ resource: 'admins', id: '' })),
    rejection(
      provider.getList({
        resource: 'admins',
        filters: [{ field: 'a', operator: 'eq', value: 1 }],
      }),
    ),
    rejection(
      provider.custom({ url: '/admin/v1/x', method: 'get', query: 'x' as unknown as object }),
    ),
    rejection(provider.create({ resource: 'admins', variables: {} })),
  ]);
  for (const error of errors) {
    expect(error.code).toBe(-4);
    expect(Object.values(LOCAL_MESSAGES)).toContain(error.msg);
    expect(error.message).toBe(error.msg);
  }
  expect(errors.at(-1)?.data).toEqual({ operation: 'create' });
});

it('an unexpected throw keeps the raw exception on cause only', async () => {
  const boom = new Error('secret internal detail');
  const onError = vi.fn();
  const provider = createDataProvider({
    baseUrl: BASE_URL,
    fetch: async () => json(PAGE),
    getToken: () => {
      throw boom;
    },
    onError,
  });
  const error = await rejection(provider.getList({ resource: 'admins' }));
  expect(error).toMatchObject({ kind: 'request', code: -4, msg: LOCAL_MESSAGES.unexpected });
  expect(error.message).not.toContain('secret');
  expect(error.cause).toBe(boom);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
});
