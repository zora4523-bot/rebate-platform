import { expect, it, vi } from 'vitest';
import { createUnionHttpTransport } from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import {
  appKey,
  beijing,
  endpoint,
  envelope,
  expectRedacted,
  formContentType,
  md5,
  method,
  secret,
  setup,
  unionFailure,
} from './kit.ts';

// The adapter over the existing https transport, with the runtime fetch replaced inside each test:
// no sockets, no listeners. Stubs are installed and removed in the test body itself.

it('[AC-B1-04j#32] through the real https transport, fetch receives one form POST to baseUrl with the signed body', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ [envelope]: { synthetic: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { adapter } = setup({ transport: createUnionHttpTransport() });
    const signal = new AbortController().signal;
    expect(await adapter.request(method, { q: 'x' }, { envelope, signal })).toEqual({
      synthetic: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(endpoint.baseUrl);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get('content-type')).toMatch(formContentType);
    expect(init?.body).toBeTypeOf('string');
    const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
    expect(form).toEqual({
      app_key: appKey,
      format: 'json',
      method,
      q: 'x',
      sign_method: 'md5',
      timestamp: beijing,
      v: '2.0',
      sign: md5(
        `${secret}app_key${appKey}formatjsonmethod${method}qxsign_methodmd5timestamp${beijing}v2.0${secret}`,
      ),
    });
    expectRedacted([String(url), init?.headers, init?.body], [secret]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('[AC-B1-04j#33] a network failure under the real transport is upstream_unavailable, not retried, without upstream text', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockRejectedValue(new Error(`${secret} network-marker`, { cause: new Error(secret) }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { adapter } = setup({ transport: createUnionHttpTransport() });
    const error = await unionFailure(
      () => adapter.request(method, { q: 'x' }, { envelope }),
      'upstream_unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectRedacted(error, [secret, 'network-marker']);
  } finally {
    vi.unstubAllGlobals();
  }
});
