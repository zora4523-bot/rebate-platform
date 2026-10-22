// Real API route assembly, no database; authenticated behavior is in http.int.test.ts.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { HEADERS } from '../../identity/token/kit.ts';
import { contract, ROOT, type Response } from '../../risk/signature/kit.ts';
import { NOW, ON, OPERATIONS, PATH, expectSchema } from './kit.ts';

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
    method: 'GET' | 'PUT';
    url: string;
    headers: Record<string, string>;
    payload?: unknown;
  }): Promise<Response>;
}

it.each(OPERATIONS)(
  '[AC-B1-12m#10] $id去planned，保持登录要求并生成契约路由schema',
  async (spec) => {
    const op = (await contract()).paths[PATH]![spec.method]! as Record<string, unknown>;
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

it('[AC-B1-12m#11] API实际注册GET和PUT各一次且挂schema，未登录均回401/10001', async () => {
  // Assert missing generated routes before bootstrap, avoiding an unrelated startup error as red.
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
    const routes: { method: string; schema?: unknown }[] = [];
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (route) => {
        if (route.url !== PATH) return;
        for (const method of [route.method].flat()) routes.push({ method, schema: route.schema });
      });
    await app.init();
    for (const spec of OPERATIONS) {
      expect(routes.filter((route) => route.method === spec.verb)).toEqual([
        { method: spec.verb, schema: Reflect.get(CONTRACT_ROUTE_SCHEMAS, spec.id) },
      ]);
      const response = await app.inject({
        method: spec.verb,
        url: PATH,
        headers: { ...HEADERS, 'x-channel': 'appstore' },
        ...(spec.verb === 'PUT' ? { payload: ON } : {}),
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({ code: 10001 });
      await expectSchema(spec.id, '4XX', response.json());
    }
  } finally {
    await app.close();
  }
}, 30_000);
