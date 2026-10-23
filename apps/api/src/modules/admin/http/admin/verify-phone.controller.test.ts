// HTTP wiring of the verify-phone routes on the admin entry (B1-34i), without a database or Redis:
// the four routes are mounted with their contract schemas, the admin check answers before the body
// is validated, and the other entries do not mount them. The operations themselves run against PG
// and Redis in test/spec/admin/admins-verify-phone.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type HttpEntry,
} from '../../../platform/index.ts';

const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const ROUTES = [
  { method: 'POST', url: '/admin/v1/me/verify-phone/sms-codes', template: null },
  { method: 'PUT', url: '/admin/v1/me/verify-phone', template: null },
  {
    method: 'POST',
    url: `/admin/v1/admins/${ID}/verify-phone/sms-codes`,
    template: '/admin/v1/admins/:admin_id/verify-phone/sms-codes',
  },
  {
    method: 'PUT',
    url: `/admin/v1/admins/${ID}/verify-phone`,
    template: '/admin/v1/admins/:admin_id/verify-phone',
  },
] as const;

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(entry: HttpEntry = 'admin') {
  app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: '127.0.0.1' }),
    clock: new FixedClock('2026-10-24T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  const routes: { method: string; url: string; schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url.includes('verify-phone')) {
        routes.push({ method: String(route.method), url: route.url, schema: route.schema });
      }
    });
  await app.init();
  return routes;
}

const send = (method: 'POST' | 'PUT', url: string) =>
  app!.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: '{}',
    remoteAddress: '127.0.0.1',
  });

it('[AC-B1-34i] the admin entry mounts the four verify-phone routes with contract body schemas', async () => {
  const routes = await build();
  for (const route of ROUTES) {
    const mounted = routes.find(
      (item) => item.method === route.method && item.url === (route.template ?? route.url),
    );
    expect(mounted, `${route.method} ${route.url}`).toBeDefined();
    expect(mounted!.schema).toMatchObject({ body: { additionalProperties: false } });
  }
});

it('[AC-B1-34i] without an admin_token every verify-phone route is 10001 before the body is validated', async () => {
  await build();
  for (const route of ROUTES) {
    const response = await send(route.method, route.url);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
  }
});

it.each(['api', 'stream'] as const)(
  '[AC-B1-34i] the %s entry does not mount the verify-phone routes',
  async (entry) => {
    await build(entry);
    for (const route of ROUTES) expect((await send(route.method, route.url)).statusCode).toBe(404);
  },
);
