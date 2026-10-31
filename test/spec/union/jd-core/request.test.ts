import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  JdCredentials,
  JdResponseKeys,
} from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import {
  appKey,
  beijing,
  endpoint,
  expectedSign,
  expectRedacted,
  formContentType,
  formFields,
  instant,
  keys,
  md5,
  method,
  otherSecret,
  secret,
  sent,
  setup,
  unionFailure,
  wrapped,
} from './kit.ts';

const formNames = [
  '360buy_param_json',
  'app_key',
  'format',
  'method',
  'sign',
  'sign_method',
  'timestamp',
  'v',
];

it('[AC-B1-04za#10] sends one signed form POST to endpoint.baseUrl with the public parameters and returns the inner object', async () => {
  const { adapter, transport, credentials, warn } = setup();
  const signal = new AbortController().signal;
  const parameters = Object.freeze({ goodsReq: Object.freeze({ keyword: 'x', pageSize: 20 }) });
  const payload = '{"goodsReq":{"keyword":"x","pageSize":20}}';
  transport.mockResolvedValue(wrapped('{"code":200,"synthetic_marker":"opaque-inner-object"}'));

  const inner = await adapter.request(method, parameters, { ...keys, signal });
  expect(inner).toMatchObject({ synthetic_marker: 'opaque-inner-object' });

  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = sent(transport);
  expect(request).toMatchObject({ platform: 'jd', url: endpoint.baseUrl, method: 'POST' });
  expect(request.url).toBe(endpoint.baseUrl);
  expect(request.url).not.toContain('?');
  expect(request.signal).toBe(signal);
  expect(new Headers(request.headers).get('content-type')).toMatch(formContentType);
  const form = formFields(request);
  expect(Object.keys(form).sort()).toEqual(formNames);
  expect(form).toMatchObject({
    '360buy_param_json': payload,
    app_key: appKey,
    format: 'json',
    method,
    sign_method: 'md5',
    timestamp: beijing,
    v: '1.0',
  });
  expect(form.sign).toBe(
    md5(
      `${secret}360buy_param_json${payload}app_key${appKey}formatjsonmethod${method}sign_methodmd5timestamp${beijing}v1.0${secret}`,
    ),
  );
  expect(warn).not.toHaveBeenCalled();
  expect(parameters).toEqual({ goodsReq: { keyword: 'x', pageSize: 20 } });
});

it('[AC-B1-04za#11] 360buy_param_json is the only business carrier: business names never become public parameters', async () => {
  const { adapter, transport } = setup();
  const parameters = Object.freeze({
    method: 'business-method',
    app_key: 'business-app-key',
    timestamp: 'business-timestamp',
    format: 'business-format',
    v: 'business-v',
    sign_method: 'business-sign-method',
    sign: 'business-sign',
    q: 'business-q',
  });
  await adapter.request(method, parameters, keys);

  const form = formFields(sent(transport));
  const payload = JSON.stringify(parameters);
  expect(Object.keys(form).sort()).toEqual(formNames);
  expect(form).toEqual({
    '360buy_param_json': payload,
    app_key: appKey,
    format: 'json',
    method,
    sign: expectedSign(payload),
    sign_method: 'md5',
    timestamp: beijing,
    v: '1.0',
  });
});

it('[AC-B1-04za#12] an empty business object still travels as 360buy_param_json', async () => {
  const { adapter, transport } = setup();
  await adapter.request(method, {}, keys);
  const form = formFields(sent(transport));
  expect(form['360buy_param_json']).toBe('{}');
  expect(form.sign).toBe(expectedSign('{}'));
});

it.each(['汉字', 'a b', 'a+b', '100%', 'a&b=c', '%20', '"quoted"', '第一行\n第二行', '😀'])(
  '[AC-B1-04za#13] the form is UTF-8 and restores %j exactly on the server side, signed as written',
  async (keyword) => {
    const { adapter, transport } = setup();
    const parameters = Object.freeze({ keyword });
    const payload = JSON.stringify(parameters);
    await adapter.request(method, parameters, keys);

    const request = sent(transport);
    const body = request.body ?? '';
    // The timestamp alone guarantees a space in every request: it must be form-encoded too.
    expect(body).not.toContain(' ');
    expect(body).not.toMatch(/[^\x20-\x7e]/);
    const form = formFields(request);
    expect(form['360buy_param_json']).toBe(payload);
    expect(form.timestamp).toBe(beijing);
    expect(form.sign).toBe(expectedSign(payload));
  },
);

it('[AC-B1-04za#14] Chinese business text is percent-encoded as UTF-8 bytes', async () => {
  const { adapter, transport } = setup();
  await adapter.request(method, { keyword: '汉' }, keys);
  expect((sent(transport).body ?? '').toUpperCase()).toContain('%E6%B1%89');
});

it('[AC-B1-04za#15] the app secret never reaches the transport request or the adapter object', async () => {
  const { adapter, transport } = setup();
  expectRedacted(adapter, [secret, appKey]);
  await adapter.request(method, { q: 'x' }, keys);
  const request = sent(transport);
  expectRedacted(request, [secret]);
  expect(request.url).not.toContain(secret);
  expect(JSON.stringify(request.headers)).not.toContain(secret);
  expect(request.body ?? '').not.toContain(secret);
  expect(Object.values(formFields(request))).not.toContain(secret);
  expectRedacted(adapter, [secret, appKey]);
  expect(inspect(adapter, { depth: null, showHidden: true })).not.toContain(secret);
  expect(inspect(adapter, { depth: null, showHidden: true })).not.toContain(appKey);
});

it('[AC-B1-04za#16] fetches credentials and the clock anew for every call, timestamp truncated to the second', async () => {
  const credentials = vi
    .fn<() => Promise<JdCredentials>>()
    .mockResolvedValueOnce({ appKey: 'first-app-key', appSecret: secret })
    .mockResolvedValueOnce({ appKey: 'second-app-key', appSecret: otherSecret });
  const clock = new FixedClock(instant);
  const { adapter, transport } = setup({ clock, credentials });

  await adapter.request(method, {}, keys);
  clock.advanceMs(1999);
  await adapter.request(method, {}, keys);

  expect(credentials).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledTimes(2);
  const first = formFields(sent(transport, 0));
  const second = formFields(sent(transport, 1));
  expect(first.timestamp).toBe('2026-10-30 23:55:42');
  expect(second.timestamp).toBe('2026-10-30 23:55:43');
  expect(first.app_key).toBe('first-app-key');
  expect(second.app_key).toBe('second-app-key');
  expect(first.sign).toBe(expectedSign('{}', { appKey: 'first-app-key' }));
  expect(second.sign).toBe(
    expectedSign('{}', {
      appKey: 'second-app-key',
      secret: otherSecret,
      timestamp: '2026-10-30 23:55:43',
    }),
  );
  expectRedacted(transport.mock.calls, [secret, otherSecret]);
});

it('[AC-B1-04za#17] awaits the asynchronous credential provider before sending, never at construction', async () => {
  const pending = Promise.withResolvers<JdCredentials>();
  const credentials = vi.fn(() => pending.promise);
  const { adapter, transport } = setup({ credentials });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();

  const result = adapter.request(method, {}, keys);
  await Promise.resolve();
  expect(credentials).toHaveBeenCalledTimes(1);
  expect(transport).not.toHaveBeenCalled();
  pending.resolve({ appKey, appSecret: secret });

  await expect(result).resolves.toMatchObject({ message: 'success' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  ['2026-10-30T16:00:00.000Z', '2026-10-31 00:00:00'],
  ['2026-12-31T16:00:00.000Z', '2027-01-01 00:00:00'],
])(
  '[AC-B1-04za#18] the injected clock at %s puts %s in the form and the signature',
  async (iso, timestamp) => {
    const { adapter, transport } = setup({ clock: new FixedClock(iso) });
    await adapter.request(method, {}, keys);
    const form = formFields(sent(transport));
    expect(form.timestamp).toBe(timestamp);
    expect(form.sign).toBe(expectedSign('{}', { timestamp }));
  },
);

it('[AC-B1-04za#19] credentials come only from the injected provider, whatever the environment holds', async () => {
  vi.stubEnv('JD_APP_KEY', 'env-app-key-marker');
  vi.stubEnv('JD_APP_SECRET', 'env-secret-marker');
  vi.stubEnv('JD_APP_SECRET_FILE', '/env-secret-file-marker');
  try {
    const { adapter, credentials, transport } = setup();
    await adapter.request(method, {}, keys);
    expect(credentials).toHaveBeenCalledTimes(1);
    const form = formFields(sent(transport));
    expect(form.app_key).toBe(appKey);
    expect(form.sign).toBe(expectedSign('{}'));
    expectRedacted(sent(transport), ['env-app-key-marker', 'env-secret-marker']);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('[AC-B1-04za#20] the archive context rides only on the transport request, never on the wire', async () => {
  const { adapter, transport } = setup();
  const archive = { appId: 'archive-app-marker', kind: 'query' };
  await adapter.request(method, { q: 'x' }, { ...keys, archive });
  await adapter.request(method, { q: 'x' }, keys);

  const withArchive = sent(transport, 0);
  expect(withArchive.archive).toEqual(archive);
  expect(withArchive.url).not.toContain('archive-app-marker');
  expect(JSON.stringify(withArchive.headers)).not.toContain('archive-app-marker');
  expect(withArchive.body ?? '').not.toContain('archive-app-marker');
  expect(Object.keys(formFields(withArchive))).not.toContain('kind');

  // Same parameters, clock and credentials: the archive context changes nothing on the wire.
  const without = sent(transport, 1);
  expect(without.archive).toBeUndefined();
  expect(without.signal).toBeUndefined();
  expect(formFields(without)).toEqual(formFields(withArchive));
  expect(without.url).toBe(withArchive.url);
  expect(without.headers).toEqual(withArchive.headers);
});

it.each<[string, () => unknown]>([
  ['network', () => new Error(`${secret} transport-marker`, { cause: new Error(secret) })],
  ['abort', () => new DOMException(`${secret} transport-marker`, 'AbortError')],
  ['timeout', () => new DOMException(`${secret} transport-marker`, 'TimeoutError')],
  [
    'unavailable',
    () => new UnionError('upstream_unavailable', 'jd transport: network failure', 'jd'),
  ],
])(
  '[AC-B1-04za#21] a transport failure (%s) is upstream_unavailable without upstream text, sent once',
  async (_kind, failure) => {
    const { adapter, transport, warn } = setup();
    transport.mockRejectedValue(failure());
    const error = await unionFailure(
      () => adapter.request(method, { q: 'x' }, keys),
      'upstream_unavailable',
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expectRedacted(error, [secret, appKey, 'transport-marker']);
  },
);

it.each<[string, UnionEndpoint]>([
  ['no gateway URL', { ...endpoint, baseUrl: null }],
  ['an endpoint of another platform', { ...endpoint, platform: 'pdd' }],
])(
  '[AC-B1-04za#22] %s is an invalid endpoint, refused before credentials or transport',
  async (_label, wrong) => {
    const credentials = vi.fn(async () => ({ appKey, appSecret: secret }));
    const transport = vi.fn(async () => wrapped());
    await unionFailure(async () => {
      const { adapter } = setup({ endpoint: wrong, credentials, transport });
      await adapter.request(method, {}, keys);
    }, 'invalid_endpoint');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

it.each<[string, JdResponseKeys]>([
  ['envelope', { ...keys, envelope: '' }],
  ['result key', { ...keys, resultKey: '' }],
])(
  '[AC-B1-04za#23] a call without a registered %s is unimplemented and touches neither credentials nor transport',
  async (_label, unregistered) => {
    const { adapter, credentials, transport } = setup();
    await unionFailure(
      () => adapter.request(method, { q: 'x' }, unregistered),
      'adapter_unimplemented',
    );
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);
