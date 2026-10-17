// F1-07b · the three user reads are served by the admin entry only, each route once with the
// schema generated from its contract operation, behind the admin login check (no database:
// unit test, no listen).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { NOW, type Response } from '../../admin/auth/kit.ts';
import { DETAIL, LIST, LOOKUP, operation, validate, type Path } from './schema.ts';

const ROOT = new URL('../../../../', import.meta.url);
const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUTES: Readonly<Record<string, Path>> = {
  [LIST]: LIST,
  [LOOKUP]: LOOKUP,
  [DETAIL.replace('{user_id}', ':user_id')]: DETAIL,
};

interface RouteOptions {
  url: string;
  method: string | string[];
  schema?: unknown;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(name: 'onRoute', hook: (route: RouteOptions) => void): unknown;
      hasRoute(options: { method: 'GET'; url: string }): boolean;
    };
  };
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

async function boot(entry: 'admin' | 'api' | 'stream') {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  const seen: { url: string; schema: unknown }[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      // Fastify may add a HEAD route for each GET (exposeHeadRoutes): count GET only.
      if (route.url in ROUTES && [route.method].flat().includes('GET')) {
        seen.push({ url: route.url, schema: route.schema });
      }
    });
  await app.init();
  return { app, seen };
}

it('[AC-F1-07b#1] admin 入口各挂一次三条 GET 路由并带契约 schema；api / stream 入口都不挂', async () => {
  const expected = [];
  for (const [url, path] of Object.entries(ROUTES)) {
    const op = await operation(path);
    expected.push({ url, schema: routeSchemaOf(op as never) });
  }
  const admin = await boot('admin');
  try {
    expect(admin.seen.sort((a, b) => (a.url < b.url ? -1 : 1))).toEqual(
      expected.sort((a, b) => (a.url < b.url ? -1 : 1)),
    );
  } finally {
    await admin.app.close();
  }
  for (const entry of ['api', 'stream'] as const) {
    const other = await boot(entry);
    try {
      expect(other.seen).toEqual([]);
      const server = other.app.getHttpAdapter().getInstance();
      for (const url of Object.keys(ROUTES)) {
        expect(server.hasRoute({ method: 'GET', url }), `${entry} ${url}`).toBe(false);
      }
    } finally {
      await other.app.close();
    }
  }
});

it('[AC-F1-07b#2] 三条路由都要后台登录：不带 admin_token 在处理前回 401 / 10001', async () => {
  const { app } = await boot('admin');
  try {
    const targets: [string, Path][] = [
      [LIST, LIST],
      [`${LOOKUP}?uid=0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01`, LOOKUP],
      [DETAIL.replace('{user_id}', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01'), DETAIL],
    ];
    for (const [url, path] of targets) {
      const response = await app.inject({ method: 'GET', url, headers: { 'x-trace-id': TRACE } });
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toMatchObject({ code: 10001, trace_id: TRACE });
      await validate(response, path);
    }
  } finally {
    await app.close();
  }
});
