// The pre-parsing registration point on a bare Fastify instance (Fastify's default error handler:
// the status of the thrown error). The envelope through GlobalErrorFilter is covered by
// global-errors.test.ts and by the rule tests of test/spec/risk/signature.
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import { PlatformFastifyAdapter } from './global-errors.ts';
import {
  installRequestChecks,
  originFormTarget,
  refuseRoutes,
  RequestRejection,
  type CheckedRequest,
  type RequestCheck,
  type RequestCheckInput,
} from './request-checks.ts';

let adapter: PlatformFastifyAdapter | undefined;
afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

function server(bodyLimit = 32) {
  adapter = new PlatformFastifyAdapter({
    loggerInstance: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    bodyLimit,
  });
  return adapter.getInstance();
}

function route(instance: ReturnType<typeof server>) {
  instance.post('/probe/:id', (request) => ({
    body: request.body ?? null,
    verifiedDevice: (request as CheckedRequest).verifiedDevice ?? null,
  }));
}

it('[BR-ID-01] installs once per server, only functions, only on a Fastify instance', () => {
  const instance = server();
  expect(() => installRequestChecks({}, [])).toThrow(TypeError);
  expect(() => installRequestChecks(instance, ['not a check' as unknown as RequestCheck])).toThrow(
    TypeError,
  );
  expect(() =>
    installRequestChecks(instance, [], 'not a filter' as unknown as () => boolean),
  ).toThrow(TypeError);
  installRequestChecks(instance, []);
  expect(() => installRequestChecks(instance, [])).toThrow(/already installed/);
});

it('[BR-ID-01] checks see the original URL, template and bytes; the parser receives the same bytes', async () => {
  const instance = server();
  const seen: Omit<RequestCheckInput, 'headers'>[] = [];
  installRequestChecks(instance, [
    async (request) => {
      const { headers, ...rest } = request;
      void headers;
      seen.push({ ...rest, rawBody: Buffer.from(rest.rawBody) });
      request.verifiedDevice = { deviceId: 'device-1', appId: 'couli' };
    },
  ]);
  route(instance);
  const payload = '{"a":"中文"}';
  const response = await instance.inject({
    method: 'POST',
    url: '/probe/a%2Fb?z=1&a=%2f',
    headers: { 'content-type': 'application/json', 'x-trace-id': 'ignored' },
    payload: Readable.from([Buffer.from(payload).subarray(0, 5), Buffer.from(payload).subarray(5)]),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    body: { a: '中文' },
    verifiedDevice: { deviceId: 'device-1', appId: 'couli' },
  });
  expect(seen).toEqual([
    expect.objectContaining({
      method: 'POST',
      url: '/probe/a%2Fb?z=1&a=%2f',
      routeTemplate: '/probe/:id',
      rawBody: Buffer.from(payload),
    }),
  ]);
});

it('[BR-ID-01] a 404 runs no check; a body above the limit is 413 before any check', async () => {
  const instance = server(8);
  const check = vi.fn(async () => undefined);
  installRequestChecks(instance, [check]);
  route(instance);
  expect(
    (await instance.inject({ method: 'POST', url: '/missing', payload: 'x' })).statusCode,
  ).toBe(404);
  for (const payload of [
    '{"too":"long"}',
    Readable.from([Buffer.from('{"too":'), Buffer.from('1}')]),
  ]) {
    const response = await instance.inject({
      method: 'POST',
      url: '/probe/1',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
  }
  expect(check).not.toHaveBeenCalled();
});

it('[BR-ID-01] the first failing check ends the request with its error; later checks are not called', async () => {
  const instance = server();
  const later = vi.fn(async () => undefined);
  installRequestChecks(instance, [
    async () => {
      throw new RequestRejection(10401, 401, 'rejected');
    },
    later,
  ]);
  route(instance);
  const response = await instance.inject({
    method: 'POST',
    url: '/probe/1',
    headers: { 'content-type': 'application/json' },
    payload: '{',
  });
  expect(response.statusCode).toBe(401);
  expect(later).not.toHaveBeenCalled();
});

it('[BR-ID-09] originFormTarget drops the scheme and authority of an absolute-form target and keeps every other byte', () => {
  for (const [target, expected] of [
    ['/v1/auth/sms-codes?b=2&a=%2f', '/v1/auth/sms-codes?b=2&a=%2f'],
    ['https://api.example.com/v1/auth/sms-codes?b=2&a=%2f', '/v1/auth/sms-codes?b=2&a=%2f'],
    [
      'HTTP://api.example.com:8080/v1/links/a%2Fb/open?tag=z&tag=x&empty=',
      '/v1/links/a%2Fb/open?tag=z&tag=x&empty=',
    ],
    ['http://user@api.example.com/p?q=%E4%B8%AD', '/p?q=%E4%B8%AD'],
    ['https://api.example.com', '/'],
    ['https://api.example.com?b=2&a=1', '/?b=2&a=1'],
    // Origin-form targets, including one whose path starts with `//`, stay as they are.
    ['//api.example.com/v1/auth/sms-codes', '//api.example.com/v1/auth/sms-codes'],
    // Not a target the router turns into a path: left unchanged (it matches no route).
    ['ftp://api.example.com/v1/auth/sms-codes', 'ftp://api.example.com/v1/auth/sms-codes'],
    ['*', '*'],
  ] as const) {
    expect({ target, origin: originFormTarget(target) }).toEqual({ target, origin: expected });
  }
});

it('[BR-ID-09] an absolute-form request target reaches the checks in origin form, path and query untouched', async () => {
  const instance = server();
  const urls: string[] = [];
  // light-my-request always sends the origin form; after routing, this hook leaves the request as
  // Node's HTTP parser hands Fastify an absolute-form target: the route matched by its path,
  // request.raw.url holding the whole target.
  instance.addHook('onRequest', async (request) => {
    request.raw.url = `https://api.example.com${request.raw.url ?? ''}`;
  });
  installRequestChecks(instance, [
    async (request) => {
      urls.push(request.url);
    },
  ]);
  route(instance);
  const response = await instance.inject({
    method: 'POST',
    url: '/probe/a%2Fb?b=2&a=%2f',
    headers: { 'content-type': 'application/json' },
    payload: '{}',
  });
  expect(response.statusCode).toBe(200);
  expect(urls).toEqual(['/probe/a%2Fb?b=2&a=%2f']);
});

it('[BR-ID-01] only routes that bufferWhen selects are buffered and checked; the others keep Fastify body handling', async () => {
  const instance = server(8);
  const check = vi.fn(async () => undefined);
  const bufferWhen = vi.fn((method: string, template: string) => template === '/probe/:id');
  installRequestChecks(instance, [check], bufferWhen);
  route(instance);
  instance.post('/open', (request) => ({ body: request.body ?? null }));
  const open = await instance.inject({
    method: 'POST',
    url: '/open',
    headers: { 'content-type': 'application/json' },
    payload: '{"a":1}',
  });
  expect(open.statusCode).toBe(200);
  expect(open.json()).toEqual({ body: { a: 1 } });
  expect(check).not.toHaveBeenCalled();
  // Fastify's own parser still guards the route outside the plan.
  const large = await instance.inject({
    method: 'POST',
    url: '/open',
    headers: { 'content-type': 'application/json' },
    payload: '{"too":"long"}',
  });
  expect(large.statusCode).toBe(413);
  expect(check).not.toHaveBeenCalled();
  expect(bufferWhen).toHaveBeenCalledWith('POST', '/open');
  const selected = await instance.inject({
    method: 'POST',
    url: '/probe/1',
    headers: { 'content-type': 'application/json' },
    payload: '{"a":1}',
  });
  expect(selected.statusCode).toBe(200);
  expect(check).toHaveBeenCalledTimes(1);
  expect(bufferWhen).toHaveBeenCalledWith('POST', '/probe/:id');
});

it('[BR-ID-09] refuseRoutes makes the registration of a refused route throw, naming method and route', () => {
  const instance = server();
  expect(() => refuseRoutes({}, () => true, 'x')).toThrow(TypeError);
  expect(() => refuseRoutes(instance, 'no' as unknown as () => boolean, 'x')).toThrow(TypeError);
  refuseRoutes(
    instance,
    (method, template) => method === 'POST' && template.startsWith('/refused'),
    'the probe entry refuses it',
  );
  expect(() => instance.post('/refused/:id', () => ({}))).toThrow(
    'the probe entry refuses it: POST /refused/:id',
  );
  expect(() =>
    instance.route({ method: ['GET', 'POST'], url: '/refused/both', handler: () => ({}) }),
  ).toThrow('the probe entry refuses it: POST /refused/both');
  expect(() => instance.get('/refused/read', () => ({}))).not.toThrow();
  expect(() => instance.post('/allowed', () => ({}))).not.toThrow();
});
