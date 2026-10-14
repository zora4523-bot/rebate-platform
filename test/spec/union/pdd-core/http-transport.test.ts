import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createUnionHttpTransport } from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import type { UnionTransportRequest } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { expectRedacted, secret, unionFailure } from './kit.ts';

// Replace the runtime fetch before constructing the real transport: no sockets or listeners.
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response('{"synthetic":true}', { status: 200, headers: { 'x-example': 'preserved' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(overrides: Partial<UnionTransportRequest> = {}): UnionTransportRequest {
  return {
    platform: 'pdd',
    url: 'https://pdd-gateway.invalid/api/router',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-sensitive': 'header-marker' },
    body: '{"example":"body-marker"}',
    ...overrides,
  };
}

it('[AC-B1-04g-HTTP#1] real transport delegates POST bytes, headers and injected signal to fetch', async () => {
  const transport = createUnionHttpTransport();
  const signal = new AbortController().signal;
  const sent = request({ signal });
  const result = await transport(sent);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(sent.url);
  expect(init).toMatchObject({ method: 'POST', body: sent.body });
  expect(init?.signal).toBe(signal);
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  expect(new Headers(init?.headers).get('x-test-sensitive')).toBe('header-marker');
  expect(result.status).toBe(200);
  expect(new Headers(result.headers).get('x-example')).toBe('preserved');
  expect(result.body).toBe('{"synthetic":true}');
});

it('[AC-B1-04g-HTTP#2] GET without a supplied signal has no invented timeout or body', async () => {
  const transport = createUnionHttpTransport();
  const result = await transport({
    platform: 'pdd',
    url: 'https://pdd-gateway.invalid/read',
    method: 'GET',
    headers: {},
  });
  expect(result.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]![1];
  expect(init?.method).toBe('GET');
  expect(init?.signal == null).toBe(true);
  expect(init?.body == null).toBe(true);
});

it.each([
  'http://pdd-gateway.invalid/api/router',
  'ftp://example.invalid/',
  'file:///example',
  'data:text/plain,example',
  '//pdd-gateway.invalid/',
  'not-a-url',
])('[AC-B1-04g-HTTP#3] rejects non-HTTPS or malformed URL %s before fetch', async (url) => {
  const transport = createUnionHttpTransport();
  const error = await unionFailure(() => transport(request({ url })), 'invalid_endpoint');
  expect(fetchMock).not.toHaveBeenCalled();
  expectRedacted(error, ['body-marker', 'header-marker']);
});

it('[AC-B1-04g-HTTP#4] network rejection is unavailable and removes sensitive error contents and cause', async () => {
  const upstream = new Error(`${secret} header-marker body-marker`, { cause: new Error(secret) });
  fetchMock.mockRejectedValue(upstream);
  const transport = createUnionHttpTransport();
  const error = await unionFailure(() => transport(request()), 'upstream_unavailable');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expectRedacted(error, [secret, 'body-marker', 'header-marker']);
});

it('[AC-B1-04g-HTTP#5] interrupted response-body reads are also sanitized network failures', async () => {
  const wire = new Response('unused');
  vi.spyOn(wire, 'text').mockRejectedValue(new Error(`${secret} body-marker`));
  fetchMock.mockResolvedValue(wire);
  const transport = createUnionHttpTransport();
  const error = await unionFailure(() => transport(request()), 'upstream_unavailable');
  expectRedacted(error, [secret, 'body-marker', 'header-marker']);
});

it.each(['AbortError', 'TimeoutError'])(
  '[AC-B1-04g-HTTP#6] caller signal %s cancels an in-flight request without resending',
  async (name) => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      // Trigger the external owner's abort while fetch is running; never wait on wall time.
      controller.abort(new DOMException(`${secret} body-marker`, name));
      init?.signal?.throwIfAborted();
      return new Response('unexpected');
    });
    const transport = createUnionHttpTransport();
    const error = await unionFailure(
      () => transport(request({ signal: controller.signal })),
      'upstream_unavailable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectRedacted(error, [secret, 'body-marker', 'header-marker']);
  },
);

it('[AC-B1-04g-HTTP#7] HTTP failure status and raw body survive transport for the adapter to classify', async () => {
  fetchMock.mockResolvedValue(
    new Response('upstream-unavailable', { status: 503, headers: { 'x-example': 'error' } }),
  );
  const transport = createUnionHttpTransport();
  const result = await transport(request());
  expect(result).toMatchObject({ status: 503, body: 'upstream-unavailable' });
  expect(new Headers(result.headers).get('x-example')).toBe('error');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
