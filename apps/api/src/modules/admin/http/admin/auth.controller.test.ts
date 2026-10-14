// HTTP wiring of the admin console authentication on the admin entry (F1-06k), without a database
// or Redis: the whitelist answers before the body schema, the admin token check refuses missing
// and foreign tokens, CORS answers the console's exact origin only, and the other entries do not
// mount the routes. The full flows run against PG and Redis in test/spec/admin/auth.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
  type HttpEntry,
} from '../../../platform/index.ts';

const ORIGIN = 'https://console.example.invalid';
const LOGIN = '/admin/v1/auth/login';
const LOGOUT = '/admin/v1/auth/logout';

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(entry: HttpEntry = 'admin', env: Record<string, string> = {}) {
  app = await createHttpApp(entry, {
    config: loadConfig({
      APP_ENV: 'test',
      ADMIN_IP_ALLOWLIST: '127.0.0.1,192.0.2.0/24',
      ADMIN_CORS_ORIGIN: ORIGIN,
      ...env,
    }),
    clock: new FixedClock('2026-10-09T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  const schemas: unknown[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url.startsWith('/admin/v1/auth/')) schemas.push(route.url);
    });
  await app.init();
  return { app, schemas };
}

const post = (url: string, payload: unknown, remoteAddress = '127.0.0.1', headers = {}) =>
  app!.inject({
    method: 'POST',
    url,
    payload: JSON.stringify(payload),
    headers: { 'content-type': 'application/json', ...headers },
    remoteAddress,
  });

it('[AC-F1-06k] [AC-F1-06l#19] the admin entry mounts the auth and step-up routes with their contract schemas', async () => {
  const { schemas } = await build();
  expect([...schemas].sort()).toEqual(
    [
      '/admin/v1/auth/login',
      '/admin/v1/auth/password',
      '/admin/v1/auth/totp/secret',
      '/admin/v1/auth/totp/bind',
      '/admin/v1/auth/totp',
      '/admin/v1/auth/logout',
      // F1-06l: step-up (me/permissions is outside /admin/v1/auth/).
      '/admin/v1/auth/step-up/sms-codes',
      '/admin/v1/auth/step-up',
    ].sort(),
  );
  expect(contractRouteSchema('adminLogin')).toBeDefined();
});

it('[AC-F1-06k] a source outside the whitelist is 10403 before the body is validated; X-Forwarded-For is not believed', async () => {
  await build();
  for (const body of [{}, { username: 'a', password: 'b' }]) {
    const refused = await post(LOGIN, body, '198.51.100.10', { 'x-forwarded-for': '127.0.0.1' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: 10403,
      data: { reason: 'admin_ip_not_allowed' },
    });
  }
  const invalid = await post(LOGIN, {}, '192.0.2.7');
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({ code: 20001 });
});

it('[AC-F1-06k] logout needs a Bearer admin_token: none, a cookie or a foreign token is 10001 without data', async () => {
  await build();
  for (const headers of [
    {},
    { cookie: 'admin_token=x.y.z' },
    { authorization: 'Bearer not-a-token' },
    { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' },
  ]) {
    const response = await post(LOGOUT, {}, '127.0.0.1', headers);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 10001, msg: '请先登录', trace_id: expect.any(String) });
  }
  const outside = await post(LOGOUT, {}, '198.51.100.1', { authorization: 'Bearer a.b.c' });
  expect(outside.json()).toMatchObject({ code: 10403, data: { reason: 'admin_ip_not_allowed' } });
});

it('[AC-F1-06k] without a database the login fails closed with 50001', async () => {
  await build();
  const response = await post(LOGIN, { username: 'ops', password: 'secret-password' });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ code: 50001 });
});

it('[AC-F1-06k] CORS answers the exact console origin only, preflight included', async () => {
  await build();
  const preflight = await app!.inject({
    method: 'OPTIONS',
    url: LOGIN,
    remoteAddress: '127.0.0.1',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN);
  expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain(
    'authorization',
  );
  const simple = await post(LOGIN, {}, '127.0.0.1', { origin: ORIGIN });
  expect(simple.headers['access-control-allow-origin']).toBe(ORIGIN);
  for (const origin of ['https://other.example.invalid', `${ORIGIN}.evil.invalid`, 'null']) {
    const denied = await app!.inject({
      method: 'OPTIONS',
      url: LOGIN,
      remoteAddress: '127.0.0.1',
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    expect((await post(LOGIN, {}, '127.0.0.1', { origin })).headers).not.toHaveProperty(
      'access-control-allow-origin',
    );
  }
  // A preflight from outside the whitelist is not answered either.
  const outside = await app!.inject({
    method: 'OPTIONS',
    url: LOGIN,
    remoteAddress: '198.51.100.3',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
  });
  expect(outside.headers['access-control-allow-origin']).toBeUndefined();
});

it('[AC-F1-06k] without ADMIN_IP_ALLOWLIST local / test allow loopback sources only', async () => {
  await build('admin', { ADMIN_IP_ALLOWLIST: '' });
  expect((await post(LOGIN, {}, '::1')).json()).toMatchObject({ code: 20001 });
  expect((await post(LOGIN, {}, '127.0.0.2')).json()).toMatchObject({ code: 20001 });
  expect((await post(LOGIN, {}, '192.0.2.7')).json()).toMatchObject({
    code: 10403,
    data: { reason: 'admin_ip_not_allowed' },
  });
});

it.each(['api', 'stream'] as const)(
  '[AC-F1-06k] the %s entry does not mount the admin routes',
  async (entry) => {
    await build(entry);
    expect((await post(LOGIN, {})).statusCode).toBe(404);
    expect((await post(LOGOUT, {})).statusCode).toBe(404);
  },
);

it('[AC-F1-06k] staging without the admin key or whitelist refuses to initialise the admin entry', async () => {
  const base = loadConfig({ APP_ENV: 'test' });
  app = await createHttpApp('admin', {
    config: { ...base, appEnv: 'staging' },
    clock: new FixedClock('2026-10-09T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'staging' }),
  });
  await expect(app.init()).rejects.toThrow(/ADMIN_TOKEN_SIGNING_KEY[\s\S]*ADMIN_IP_ALLOWLIST/);
});

it('[AC-F1-06k] a contract admin / super route added after init is behind the admin check', async () => {
  await build();
  const server = app!.getHttpAdapter().getInstance();
  // me/permissions (F1-06l) and the admins reads (F1-06m) are real routes; a still-planned
  // contract admin route added after init is behind the same check.
  server.get('/admin/v1/platform-icons', () => ({ code: 0, data: {} }));
  for (const url of ['/admin/v1/me/permissions', '/admin/v1/admins', '/admin/v1/platform-icons']) {
    const response = await app!.inject({ method: 'GET', url, remoteAddress: '127.0.0.1' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
    const outside = await app!.inject({ method: 'GET', url, remoteAddress: '198.51.100.4' });
    expect(outside.json()).toMatchObject({ code: 10403, data: { reason: 'admin_ip_not_allowed' } });
  }
});

it('[AC-F1-06k] a new password above 128 characters is 20001 naming new_password', async () => {
  await build();
  const response = await post('/admin/v1/auth/password', {
    login_ticket: 'ticket',
    new_password: 'x'.repeat(129),
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['new_password'] } });
});
