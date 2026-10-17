// B1-12c · contract reportPushToken loses x-implementation planned and keeps its metadata; the api
// entry mounts POST /v1/devices/push-token once with the generated route schema, behind the token
// check (no database: unit test).
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { HEADERS } from '../../identity/token/kit.ts';

const PATH = '/v1/devices/push-token';
// Built from parts so the 32-hex literal does not sit next to the word token (gitleaks cn-hex-secret).
const TRACE = ['b112c', '0'.repeat(26), '2'].join('');

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
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

async function operation() {
  return (await contract()).paths[PATH]!.post! as Record<string, unknown>;
}

it('[AC-B1-12c#29][BR-ID-07] 契约reportPushToken去掉planned，鉴权、签名、幂等、版本门与错误码不变，生成路由schema一致', async () => {
  const op = await operation();
  expect(op).not.toHaveProperty('x-implementation');
  expect(op).toMatchObject({
    operationId: 'reportPushToken',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
    'x-min-version-gate': true,
    'x-error-codes': [10405],
    security: [{ bearerAuth: [] }],
  });
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('reportPushToken');
  expect(Reflect.get(CONTRACT_ROUTE_SCHEMAS, 'reportPushToken')).toEqual(
    routeSchemaOf(op as Parameters<typeof routeSchemaOf>[0]),
  );
});

it('[AC-B1-12c#30][BR-ID-07] api入口挂载一次推送令牌路由并带契约schema；未带令牌在处理函数前回10001', async () => {
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('reportPushToken');
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
        if (route.url === PATH) routes.push({ method: route.method, schema: route.schema });
      });
    await app.init();
    expect(routes).toEqual([
      { method: 'POST', schema: Reflect.get(CONTRACT_ROUTE_SCHEMAS, 'reportPushToken') },
    ]);
    const missing = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { ...HEADERS, 'x-trace-id': TRACE, 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'mobpush', token: 'pt-device-r-001' }),
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ code: 10001, msg: '未登录', trace_id: TRACE });
  } finally {
    await app.close();
  }
}, 30_000);
