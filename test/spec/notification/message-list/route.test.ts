// Unit-level API assembly: no database, ports are never invoked before login.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { HEADERS } from '../../identity/token/kit.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { NOW, OPERATIONS, expectSchema } from './kit.ts';

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
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<Response>;
}

it.each(OPERATIONS)(
  '[AC-B1-12k#7] $id去planned，保留登录要求，并随契约生成路由schema',
  async (spec) => {
    const op = (await contract()).paths[spec.path]![spec.method]! as Record<string, unknown>;
    expect(op).not.toHaveProperty('x-implementation');
    expect(op).toMatchObject({
      operationId: spec.id,
      'x-auth': 'login',
      'x-signed': false,
      'x-idempotent': false,
      security: [{ bearerAuth: [] }],
    });
    expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty(spec.id);
    expect(Reflect.get(CONTRACT_ROUTE_SCHEMAS, spec.id)).toEqual(
      routeSchemaOf(op as Parameters<typeof routeSchemaOf>[0]),
    );
  },
);

it('[AC-B1-12k#8] API实际注册三个路由各一次并挂schema；三个操作未登录都回401/10001', async () => {
  // A real missing-route assertion, also prevents an unrelated bootstrap failure masking red.
  for (const spec of OPERATIONS) expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty(spec.id);
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock(NOW),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    const routes: { url: string; method: string; schema?: unknown }[] = [];
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (route) => {
        for (const spec of OPERATIONS) {
          const method = spec.method === 'get' ? 'GET' : 'POST';
          if (route.url === spec.path && [route.method].flat().includes(method)) {
            routes.push({ url: route.url, method, schema: route.schema });
          }
        }
      });
    await app.init();
    for (const spec of OPERATIONS) {
      const method = spec.method === 'get' ? 'GET' : 'POST';
      expect(routes.filter((route) => route.url === spec.path)).toEqual([
        { url: spec.path, method, schema: Reflect.get(CONTRACT_ROUTE_SCHEMAS, spec.id) },
      ]);
      const response = await app.inject({
        method,
        url: spec.path,
        headers: { ...HEADERS, 'x-channel': 'appstore' },
        ...(method === 'POST' ? { payload: { all: true } } : {}),
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001 });
      await expectSchema(spec.id, '4XX', response.json());
    }
  } finally {
    await app.close();
  }
}, 30_000);
