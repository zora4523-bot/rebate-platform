import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  REQUEST_CHECKS,
  type RequestCheckPlan,
} from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { HEADERS, INSTANT, routes } from './kit.ts';
import { ROOT, type RequestCheckServer, type Response } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): { getInstance(): RequestCheckServer };
  inject(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
function overrides() {
  return {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock(INSTANT),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  };
}
const BOOTSTRAP = new URL('apps/api/src/bootstrap.ts', ROOT).href;
async function bootstrap() {
  return (await import(BOOTSTRAP)) as {
    createHttpApp(entry: 'api', options: ReturnType<typeof overrides>): Promise<App>;
  };
}

for (const auth of ['login', 'optional', 'realname'] as const) {
  it(`[BR-ID-01][04 §5] 真实api计划覆盖非签名${auth}路由，拒绝发生在处理函数前`, async () => {
    const candidate = (await routes()).find(
      (route) =>
        route.auth === auth &&
        !route.signed &&
        (auth !== 'login' || route.method === 'POST') &&
        !Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, route.operation.operationId ?? ''),
    );
    expect(candidate, '必须从未实现契约操作中选择桩，不能覆盖已实现路由').toBeDefined();
    const { createHttpApp } = await bootstrap();
    const app = await createHttpApp('api', overrides());
    const handler = vi.fn(() => ({ reached: true }));
    try {
      app
        .getHttpAdapter()
        .getInstance()
        .route({
          method: candidate!.method,
          url: candidate!.path,
          ...(auth === 'login' ? { bodyLimit: 8 } : {}),
          handler,
        });
      await app.init();
      const response = await app.inject({
        method: candidate!.method,
        url: candidate!.path.replace(/:[^/]+/g, 'test-id'),
        headers: {
          ...HEADERS,
          ...(auth === 'optional' ? { authorization: 'Bearer invalid-token' } : {}),
          ...(auth === 'login' ? { 'content-type': 'application/json' } : {}),
        },
        // Valid JSON larger than bodyLimit: stage ② must reject before any body is read.
        ...(auth === 'login' ? { payload: JSON.stringify('x'.repeat(62)) } : {}),
      });
      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body['code']).toBe(auth === 'optional' ? 10002 : 10001);
      expect((await envelopeValidator())(body)).toBe(true);
      expect(body).not.toHaveProperty('data');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 30_000);
}

it('[BR-ID-01] bootstrap拒绝签名检查不是第一项的计划，即使列表后面有签名检查', async () => {
  const moduleUrl = new URL('apps/api/src/app.module.ts', ROOT).href;
  const { AppModule } = (await import(moduleUrl)) as {
    AppModule: { forEntry(options: unknown): { providers?: unknown[] } };
  };
  const original = AppModule.forEntry;
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    const providers = (module.providers ?? []).map((provider) => {
      if (
        typeof provider !== 'object' ||
        provider === null ||
        !('provide' in provider) ||
        provider.provide !== REQUEST_CHECKS ||
        !('useFactory' in provider)
      )
        return provider;
      const factory = provider.useFactory as (...values: unknown[]) => RequestCheckPlan;
      return {
        ...provider,
        useFactory: (...values: unknown[]) => {
          const plan = factory(...values);
          return { ...plan, checks: [async () => undefined, ...plan.checks] };
        },
      };
    });
    return { ...module, providers };
  });
  let app: App | undefined;
  try {
    const { createHttpApp } = await bootstrap();
    await expect(
      createHttpApp('api', overrides()).then((created) => {
        app = created;
        return 'resolved' as const;
      }),
    ).rejects.toThrow(/signature|签名/i);
  } finally {
    await app?.close();
    spy.mockRestore();
  }
});
