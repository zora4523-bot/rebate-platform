import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  DataokeCredentials,
  DataokeHttpMethod,
  DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import {
  appKey,
  baseUrl,
  expectedSignRan,
  expectRedacted,
  formContentType,
  formFields,
  instant,
  nonce,
  NONCE_BOUND,
  ok,
  otherSecret,
  path,
  queryFields,
  secret,
  sent,
  setup,
  timer,
  unionFailure,
  version,
  wireFields,
} from './kit.ts';

const methods: readonly DataokeHttpMethod[] = ['GET', 'POST'];

it('[AC-B1-04m#9] GET sends one request to baseUrl + path with every parameter in the query string, no body, and returns data', async () => {
  const { client, transport, credentials, random, warn } = setup();
  const signal = new AbortController().signal;
  const parameters = Object.freeze({ pageSize: 100, startTime: '2026-10-30 20:00:00' });
  const data = { synthetic_marker: 'opaque-data-object', list: [{ untouched: 0 }] };
  transport.mockResolvedValue(ok(data));

  expect(await client.request('GET', path, parameters, { version, signal })).toEqual(data);

  expect(credentials).toHaveBeenCalledTimes(1);
  expect(random.mock.calls).toEqual([[NONCE_BOUND]]);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = sent(transport);
  expect(request).toMatchObject({ platform: 'taobao', method: 'GET' });
  expect(request.signal).toBe(signal);
  expect(request.body).toBeUndefined();
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${baseUrl}${path}`);
  expect(url.hash).toBe('');
  expect(queryFields(request)).toEqual({
    appKey,
    version,
    timer,
    nonce,
    signRan: expectedSignRan(appKey, timer, nonce, secret),
    pageSize: '100',
    startTime: '2026-10-30 20:00:00',
  });
  expect(warn).not.toHaveBeenCalled();
  expect(parameters).toEqual({ pageSize: 100, startTime: '2026-10-30 20:00:00' });
});

it('[AC-B1-04m#10] POST sends one UTF-8 form to baseUrl + path with every parameter in the body and no query string', async () => {
  const { client, transport, credentials, random, warn } = setup();
  const signal = new AbortController().signal;
  const parameters = Object.freeze({ pageNo: 1, startTime: '2026-10-30 20:00:00' });
  const data = { synthetic_marker: 'opaque-data-object' };
  transport.mockResolvedValue(ok(data));

  expect(await client.request('POST', path, parameters, { version, signal })).toEqual(data);

  expect(credentials).toHaveBeenCalledTimes(1);
  expect(random.mock.calls).toEqual([[NONCE_BOUND]]);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = sent(transport);
  expect(request).toMatchObject({ platform: 'taobao', method: 'POST' });
  expect(request.url).toBe(`${baseUrl}${path}`);
  expect(request.url).not.toContain('?');
  expect(request.signal).toBe(signal);
  expect(new Headers(request.headers).get('content-type')).toMatch(formContentType);
  expect(formFields(request)).toEqual({
    appKey,
    version,
    timer,
    nonce,
    signRan: expectedSignRan(appKey, timer, nonce, secret),
    pageNo: '1',
    startTime: '2026-10-30 20:00:00',
  });
  expect(warn).not.toHaveBeenCalled();
  expect(parameters).toEqual({ pageNo: 1, startTime: '2026-10-30 20:00:00' });
});

it('[AC-B1-04m#11] the app secret never reaches the transport request or the client object; only signRan goes out', async () => {
  const { client, transport } = setup();
  expectRedacted(client, [secret]);
  await client.request('GET', path, { q: 'x' }, { version });
  await client.request('POST', path, { q: 'x' }, { version });
  for (const request of [sent(transport, 0), sent(transport, 1)]) {
    expectRedacted(request, [secret]);
    expect(request.url).not.toContain(secret);
    expect(JSON.stringify(request.headers)).not.toContain(secret);
    expect(request.body ?? '').not.toContain(secret);
    const fields = wireFields(request);
    expect(Object.values(fields)).not.toContain(secret);
    expect(fields.signRan).toBe(expectedSignRan(appKey, timer, nonce, secret));
  }
  expectRedacted(client, [secret]);
  expect(inspect(client, { depth: null, showHidden: true })).not.toContain(secret);
});

it('[AC-B1-04m#12] fetches credentials, the clock and a fresh nonce for every call', async () => {
  const credentials = vi
    .fn<() => Promise<DataokeCredentials>>()
    .mockResolvedValueOnce({ appKey: 'first-app-key', appSecret: secret })
    .mockResolvedValueOnce({ appKey: 'second-app-key', appSecret: otherSecret });
  const random = vi.fn<DataokeRandom>().mockReturnValueOnce(1).mockReturnValueOnce(999_999);
  const clock = new FixedClock(instant);
  const { client, transport } = setup({ clock, credentials, random });

  await client.request('GET', path, {}, { version });
  clock.advanceMs(1999);
  await client.request('POST', path, {}, { version });

  expect(credentials).toHaveBeenCalledTimes(2);
  expect(random.mock.calls).toEqual([[NONCE_BOUND], [NONCE_BOUND]]);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(queryFields(sent(transport, 0))).toEqual({
    appKey: 'first-app-key',
    version,
    timer: '1793375742123',
    nonce: '000001',
    signRan: expectedSignRan('first-app-key', '1793375742123', '000001', secret),
  });
  expect(formFields(sent(transport, 1))).toEqual({
    appKey: 'second-app-key',
    version,
    timer: '1793375744122',
    nonce: '999999',
    signRan: expectedSignRan('second-app-key', '1793375744122', '999999', otherSecret),
  });
  expectRedacted(transport.mock.calls, [secret, otherSecret]);
});

it('[AC-B1-04m#13] business parameters and version take no part in signRan', async () => {
  const { client, transport } = setup();
  await client.request('GET', path, { a: '1' }, { version });
  await client.request('GET', path, { b: '2', q: '汉字' }, { version });
  await client.request('POST', path, { pageNo: 3 }, { version });
  await client.request('GET', path, { a: '1' }, { version: 'v2.0.0' });

  const expected = expectedSignRan(appKey, timer, nonce, secret);
  expect(transport).toHaveBeenCalledTimes(4);
  for (const index of [0, 1, 2, 3]) {
    expect(wireFields(sent(transport, index)).signRan).toBe(expected);
  }
  expect(queryFields(sent(transport, 3)).version).toBe('v2.0.0');
});

it('[AC-B1-04m#14] awaits the asynchronous credential provider before sending, never at construction', async () => {
  const pending = Promise.withResolvers<DataokeCredentials>();
  const credentials = vi.fn(() => pending.promise);
  const { client, transport } = setup({ credentials });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();

  const result = client.request('GET', path, {}, { version });
  await Promise.resolve();
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
  pending.resolve({ appKey, appSecret: secret });

  await expect(result).resolves.toEqual({});
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(methods)(
  '[AC-B1-04m#15] %s sends UTF-8 text, numbers and booleans as strings and leaves undefined, null and empty strings out',
  async (method) => {
    const { client, transport } = setup();
    const parameters = Object.freeze({
      q: '汉字 &+=%',
      flag: true,
      no: false,
      zero: 0,
      n: 12.5,
      empty: '',
      nothing: null,
      missing: undefined,
    });
    await client.request(method, path, parameters, { version });

    const request = sent(transport);
    const raw = method === 'GET' ? new URL(request.url).search : (request.body ?? '');
    expect(raw).not.toContain('汉');
    expect(raw.toUpperCase()).toContain('%E6%B1%89');
    expect(wireFields(request)).toEqual({
      appKey,
      version,
      timer,
      nonce,
      signRan: expectedSignRan(appKey, timer, nonce, secret),
      q: '汉字 &+=%',
      flag: 'true',
      no: 'false',
      zero: '0',
      n: '12.5',
    });
    expect(parameters).toEqual({
      q: '汉字 &+=%',
      flag: true,
      no: false,
      zero: 0,
      n: 12.5,
      empty: '',
      nothing: null,
      missing: undefined,
    });
  },
);

it.each(
  ['appKey', 'version', 'timer', 'nonce', 'signRan'].flatMap((name) =>
    methods.map((method): [string, DataokeHttpMethod] => [name, method]),
  ),
)(
  '[AC-B1-04m#16] a business parameter named like the public parameter %s is refused before sending (%s)',
  async (reserved, method) => {
    const { client, transport } = setup();
    await unionFailure(
      () => client.request(method, path, { [reserved]: 'business-value' }, { version }),
      'invalid_dto',
    );
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  '[AC-B1-04m#17] a non-finite business number (%d) is refused before sending',
  async (value) => {
    const { client, transport } = setup();
    for (const method of methods) {
      await unionFailure(
        () => client.request(method, path, { pageSize: value }, { version }),
        'invalid_dto',
      );
    }
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04m#18] an empty interface version is refused before sending', async () => {
  const { client, transport } = setup();
  for (const method of methods) {
    await unionFailure(() => client.request(method, path, {}, { version: '' }), 'invalid_dto');
  }
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  '',
  'api/tb-service/get-order-details',
  'https://elsewhere.invalid/api/x',
  '//elsewhere.invalid/api/x',
  '/api/../x',
  '/api/./x',
  '/api/x?extra=1',
  '/api/x#fragment',
  '/api\\x',
])(
  '[AC-B1-04m#19] the path %j is not a plain absolute path under baseUrl and is refused before sending',
  async (badPath) => {
    const { client, transport } = setup();
    for (const method of methods) {
      await unionFailure(() => client.request(method, badPath, {}, { version }), 'invalid_dto');
    }
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04m#20] a trailing slash on baseUrl does not double the slash before the path', async () => {
  const { client, transport } = setup({ baseUrl: `${baseUrl}/` });
  await client.request('POST', path, {}, { version });
  await client.request('GET', path, {}, { version });
  expect(sent(transport, 0).url).toBe(`${baseUrl}${path}`);
  const url = new URL(sent(transport, 1).url);
  expect(`${url.origin}${url.pathname}`).toBe(`${baseUrl}${path}`);
});

it.each([
  'http://dataoke-gateway.invalid',
  'ftp://dataoke-gateway.invalid',
  'dataoke-gateway.invalid',
  '',
])(
  '[AC-B1-04m#21] baseUrl %j is not https: invalid_endpoint, before credentials or transport',
  async (wrong) => {
    const credentials = vi.fn(async () => ({ appKey, appSecret: secret }));
    const transport = vi.fn(async () => ok());
    await unionFailure(async () => {
      const { client } = setup({ baseUrl: wrong, credentials, transport });
      await client.request('GET', path, {}, { version });
    }, 'invalid_endpoint');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each([NONCE_BOUND, -1, 0.5, Number.NaN])(
  '[AC-B1-04m#22] a random source value of %d cannot make a six-digit nonce: RangeError, nothing sent',
  async (value) => {
    const random = vi.fn<DataokeRandom>().mockReturnValue(value);
    const { client, transport } = setup({ random });
    for (const method of methods) {
      let caught: unknown;
      try {
        await client.request(method, path, {}, { version });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RangeError);
      expectRedacted(caught, [secret]);
    }
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each(methods)(
  '[AC-B1-04m#23] the archive context rides only on the transport request, never on the wire (%s)',
  async (method) => {
    const { client, transport } = setup();
    const archive = { appId: 'archive-app-marker', kind: 'order' };
    await client.request(method, path, { q: 'x' }, { version, archive });
    await client.request(method, path, { q: 'x' }, { version });

    const withArchive = sent(transport, 0);
    expect(withArchive.archive).toEqual(archive);
    expect(withArchive.url).not.toContain('archive-app-marker');
    expect(JSON.stringify(withArchive.headers)).not.toContain('archive-app-marker');
    expect(withArchive.body ?? '').not.toContain('archive-app-marker');
    expect(Object.keys(wireFields(withArchive))).not.toContain('kind');
    expect(Object.keys(wireFields(withArchive))).not.toContain('appId');

    // Same parameters, clock, nonce and credentials: the archive context changes nothing on the wire.
    const without = sent(transport, 1);
    expect(without.archive).toBeUndefined();
    expect(without.signal).toBeUndefined();
    expect(without.url).toBe(withArchive.url);
    expect(without.body).toBe(withArchive.body);
    expect(without.headers).toEqual(withArchive.headers);
  },
);

it.each<[string, () => unknown]>([
  ['network', () => new Error(`${secret} transport-marker`, { cause: new Error(secret) })],
  ['abort', () => new DOMException(`${secret} transport-marker`, 'AbortError')],
  ['timeout', () => new DOMException(`${secret} transport-marker`, 'TimeoutError')],
  [
    'unavailable',
    () => new UnionError('upstream_unavailable', 'taobao transport: network failure', 'taobao'),
  ],
])(
  '[AC-B1-04m#24] a transport failure (%s) is upstream_unavailable without upstream text, sent once',
  async (_kind, failure) => {
    for (const method of methods) {
      const { client, transport, warn } = setup();
      transport.mockRejectedValue(failure());
      const error = await unionFailure(
        () => client.request(method, path, { q: 'param-marker' }, { version }),
        'upstream_unavailable',
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expectRedacted(error, [
        secret,
        'transport-marker',
        'param-marker',
        expectedSignRan(appKey, timer, nonce, secret),
      ]);
    }
  },
);
