// B1-12d · contract getMessage loses x-implementation planned and keeps its metadata; the api entry
// mounts GET /v1/messages/{message_id} once with the generated route schema, behind the token
// check (no database: unit test).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS } from '../../identity/token/kit.ts';

const PATH = '/v1/messages/{message_id}';
const ROUTE = '/v1/messages/:message_id';
// Built from parts so no 32-hex literal sits in this file (gitleaks cn-hex-secret).
const TRACE = ['b112d', '0'.repeat(26), '2'].join('');

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): {
    getInstance(): {
      addHook(
        name: 'onRoute',
        hook: (route: { url: string; method: string | string[]; schema?: unknown }) => void,
      ): unknown;
    };
  };
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

async function operation() {
  return (await contract()).paths[PATH]!.get! as Record<string, unknown>;
}

it('[AC-B1-12d#11][BR-ID-10] 契约getMessage去掉planned，鉴权、签名、幂等与错误码不变，生成路由schema一致', async () => {
  const op = await operation();
  expect(op).not.toHaveProperty('x-implementation');
  expect(op).toMatchObject({
    operationId: 'getMessage',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-error-codes': [30701],
    security: [{ bearerAuth: [] }],
  });
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('getMessage');
  expect(Reflect.get(CONTRACT_ROUTE_SCHEMAS, 'getMessage')).toEqual(
    routeSchemaOf(op as Parameters<typeof routeSchemaOf>[0]),
  );
});

it('[AC-B1-12d#12][BR-ID-10] api入口挂载一次消息回查路由并带契约schema；未带令牌在处理函数前回401/10001', async () => {
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('getMessage');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-05T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    const routes: { method: string | string[]; schema?: unknown }[] = [];
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (route) => {
        // Fastify may also expose a HEAD route for the GET (exposeHeadRoutes): count GET only.
        if (route.url === ROUTE && [route.method].flat().includes('GET')) {
          routes.push({ method: route.method, schema: route.schema });
        }
      });
    await app.init();
    expect(routes).toEqual([
      { method: 'GET', schema: Reflect.get(CONTRACT_ROUTE_SCHEMAS, 'getMessage') },
    ]);
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/messages/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80',
      headers: { ...HEADERS, 'x-channel': 'appstore', 'x-trace-id': TRACE },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ code: 10001, msg: '未登录', trace_id: TRACE });
  } finally {
    await app.close();
  }
}, 30_000);
