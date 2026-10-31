import { expect, it, vi } from 'vitest';
import { createUnionHttpTransport } from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import {
  appKey,
  beijing,
  endpoint,
  envelope,
  expectedSign,
  expectRedacted,
  formContentType,
  innerOk,
  keys,
  method,
  resultKey,
  secret,
  setup,
  unionFailure,
} from './kit.ts';

// The adapter over the existing https transport, with the runtime fetch replaced inside each test:
// no sockets, no listeners. Stubs are installed and removed in the test body itself.

it('[AC-B1-04za#54] through the real https transport, fetch receives one form POST to baseUrl with the signed body', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ [envelope]: { code: '0', [resultKey]: innerOk } }), {
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { adapter } = setup({ transport: createUnionHttpTransport() });
    const signal = new AbortController().signal;
    expect(await adapter.request(method, { q: '汉字' }, { ...keys, signal })).toMatchObject({
      message: 'success',
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
      '360buy_param_json': '{"q":"汉字"}',
      app_key: appKey,
      format: 'json',
      method,
      sign: expectedSign('{"q":"汉字"}'),
      sign_method: 'md5',
      timestamp: beijing,
      v: '1.0',
    });
    expectRedacted([String(url), init?.headers, init?.body], [secret]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('[AC-B1-04za#55] a network failure under the real transport is upstream_unavailable, not retried, without upstream text', async () => {
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockRejectedValue(new Error(`${secret} network-marker`, { cause: new Error(secret) }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const { adapter } = setup({ transport: createUnionHttpTransport() });
    const error = await unionFailure(
      () => adapter.request(method, { q: 'x' }, keys),
      'upstream_unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectRedacted(error, [secret, appKey, 'network-marker']);
  } finally {
    vi.unstubAllGlobals();
  }
});
