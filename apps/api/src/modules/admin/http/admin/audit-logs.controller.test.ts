// HTTP wiring of the audit search on the admin entry (B1-34a), without a database or Redis: both
// routes are mounted with their contract schemas, the admin check answers before the query is
// validated, and the other entries do not mount them. The reads themselves run against PG in
// test/spec/admin/audit-query.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it } from 'vitest';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type HttpEntry,
} from '../../../platform/index.ts';

const LIST = '/admin/v1/audit-logs';
const DETAIL = `${LIST}/aud_AAAAAAAAAAAAAAAAAAAAAA`;

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

it('[AC-B1-34a] the admin entry mounts the list and detail routes with contract schemas', async () => {
  const routes = await build();
  const byUrl = new Map(routes.map((r) => [r.url, r.schema]));
  expect(byUrl.get(LIST)).toMatchObject({ querystring: { additionalProperties: false } });
  expect(byUrl.get(`${LIST}/:id`)).toMatchObject({ params: { required: ['id'] } });
});

it('[AC-B1-34a] without an admin_token both reads are 10001 before the query is validated', async () => {
  await build();
  for (const url of [LIST, `${LIST}?page_size=201`, DETAIL, `${LIST}/x`]) {
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
  '[AC-B1-34a] the %s entry does not mount the reads',
  async (entry) => {
    await build(entry);
    expect((await get(LIST)).statusCode).toBe(404);
    expect((await get(DETAIL)).statusCode).toBe(404);
  },
);
