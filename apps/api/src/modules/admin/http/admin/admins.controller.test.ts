// HTTP wiring of the read-only admin accounts on the admin entry (F1-06m), without a database or
// Redis: both routes are mounted with their contract schemas, the admin check answers before the
// query is validated, and the other entries do not mount them. The reads themselves run against
// PG in test/spec/admin/accounts.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type HttpEntry,
} from '../../../platform/index.ts';

const LIST = '/admin/v1/admins';
const DETAIL = `${LIST}/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01`;

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(entry: HttpEntry = 'admin') {
  app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', ADMIN_IP_ALLOWLIST: '127.0.0.1' }),
    clock: new FixedClock('2026-10-09T02:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  const routes: { url: string; schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      if (route.url.startsWith(LIST)) routes.push({ url: route.url, schema: route.schema });
    });
  await app.init();
  return routes;
}

const get = (url: string, remoteAddress = '127.0.0.1') =>
  app!.inject({ method: 'GET', url, remoteAddress });

it('[AC-F1-06m] the admin entry mounts the list and detail routes with contract schemas', async () => {
  const routes = await build();
  const byUrl = new Map(routes.map((r) => [r.url, r.schema]));
  expect(byUrl.get(LIST)).toMatchObject({ querystring: { additionalProperties: false } });
  expect(byUrl.get(`${LIST}/:admin_id`)).toMatchObject({ params: { required: ['admin_id'] } });
});

it('[AC-F1-06m] without an admin_token both reads are 10001 before the query is validated', async () => {
  await build();
  for (const url of [LIST, `${LIST}?page_size=201`, DETAIL, `${LIST}/not-a-uuid`]) {
    const response = await get(url);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
  }
  expect((await get(LIST, '198.51.100.9')).json()).toMatchObject({
    code: 10403,
    data: { reason: 'admin_ip_not_allowed' },
  });
});

it.each(['api', 'stream'] as const)(
  '[AC-F1-06m] the %s entry does not mount the reads',
  async (entry) => {
    await build(entry);
    expect((await get(LIST)).statusCode).toBe(404);
    expect((await get(DETAIL)).statusCode).toBe(404);
  },
);
