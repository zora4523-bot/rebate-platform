// The pre-parsing registration point on a bare Fastify instance (Fastify's default error handler:
// the status of the thrown error). The envelope through GlobalErrorFilter is covered by
// global-errors.test.ts and by the rule tests of test/spec/risk/signature.
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createRootLogger } from '../logging/index.ts';
import { PlatformFastifyAdapter } from './global-errors.ts';
import {
  installRequestChecks,
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
