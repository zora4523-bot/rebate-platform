import { expect, it, vi } from 'vitest';
import { createUnionHttpTransport } from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import {
  appKey,
  baseUrl,
  expectedSignRan,
  expectRedacted,
  formContentType,
  nonce,
  path,
  secret,
  setup,
  timer,
  unionFailure,
  version,
} from './kit.ts';

// The client over the existing https transport, with the runtime fetch replaced inside each test:
// no sockets, no listeners. Stubs are installed and removed in the test body itself.

function okResponse(): Response {
  return new Response(
    JSON.stringify({ time: 1793375742200, code: 0, msg: '成功', data: { synthetic: true } }),
    { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } },
  );
}

it('[AC-B1-04m#32] GET through the real https transport: fetch receives baseUrl + path with the signed query and no body', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { client } = setup({ transport: createUnionHttpTransport() });
    const signal = new AbortController().signal;
    expect(await client.request('GET', path, { q: 'x' }, { version, signal })).toEqual({
      synthetic: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(`${baseUrl}${path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      appKey,
      version,
      timer,
      nonce,
      signRan: expectedSignRan(appKey, timer, nonce, secret),
      q: 'x',
    });
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBe(signal);
    expectRedacted([String(input), init?.headers], [secret]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('[AC-B1-04m#33] POST through the real https transport: fetch receives one form to baseUrl + path with the signed body', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { client } = setup({ transport: createUnionHttpTransport() });
    expect(await client.request('POST', path, { q: 'x' }, { version })).toEqual({
      synthetic: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(`${baseUrl}${path}`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toMatch(formContentType);
    expect(init?.body).toBeTypeOf('string');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      appKey,
      version,
      timer,
      nonce,
      signRan: expectedSignRan(appKey, timer, nonce, secret),
      q: 'x',
    });
    expectRedacted([String(input), init?.headers, init?.body], [secret]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('[AC-B1-04m#34] a network failure under the real transport is upstream_unavailable, not retried, without upstream text', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockRejectedValue(new Error(`${secret} network-marker`, { cause: new Error(secret) }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { client } = setup({ transport: createUnionHttpTransport() });
    for (const method of ['GET', 'POST'] as const) {
      fetchMock.mockClear();
      const error = await unionFailure(
        () => client.request(method, path, { q: 'x' }, { version }),
        'upstream_unavailable',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectRedacted(error, [secret, 'network-marker']);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
