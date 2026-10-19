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
import { ROOT, type Response } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

/** The Fastify route options the stub below uses (constraints / onRequest: B1-13i). */
interface StubRouter {
  route(options: {
    method: string;
    url: string;
    bodyLimit?: number;
    constraints: { host: string };
    onRequest: (request: unknown, reply: unknown, done: () => void) => void;
    handler: () => unknown;
  }): unknown;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): { getInstance(): StubRouter };
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

// B1-13i: B1-13e implemented the last realname non-signed operation (getPayoutAccount), so the
// stub can no longer rely on the contract still holding an unimplemented operation of each level.
// An unimplemented operation is still preferred; otherwise an implemented one of the same level is
// used. Either way the stub is registered under a Fastify host constraint (find-my-way prefers a
// matching constrained route), so it never replaces or collides with a route Nest registers, while
// Fastify's matched route template (`routeOptions.url`, what stages ② ③ look the level up by in
// the contract table) stays the contract path. The stub's route-level onRequest hook proves that
// the request was routed to the stub (it runs before preParsing, where the request checks run);
// the uncalled handler proves the rejection happened before any handler.
const STUB_HOST = 'b113i-stub.invalid';

for (const auth of ['login', 'optional', 'realname'] as const) {
  it(`[BR-ID-01][04 §5] 真实api计划覆盖非签名${auth}路由，拒绝发生在处理函数前`, async () => {
    const eligible = (await routes()).filter(
      (route) =>
        route.auth === auth && !route.signed && (auth !== 'login' || route.method === 'POST'),
    );
    const candidate =
      eligible.find(
        (route) => !Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, route.operation.operationId ?? ''),
      ) ?? eligible[0];
    expect(candidate, `契约必须存在非签名${auth}操作用来挂桩`).toBeDefined();
    const { createHttpApp } = await bootstrap();
    const app = await createHttpApp('api', overrides());
    const matched = vi.fn();
    const handler = vi.fn(() => ({ reached: true }));
    try {
      app
        .getHttpAdapter()
        .getInstance()
        .route({
          method: candidate!.method,
          url: candidate!.path,
          ...(auth === 'login' ? { bodyLimit: 8 } : {}),
          constraints: { host: STUB_HOST },
          onRequest: (_request, _reply, done) => {
            matched();
            done();
          },
          handler,
        });
      await app.init();
      const response = await app.inject({
        method: candidate!.method,
        url: candidate!.path.replace(/:[^/]+/g, 'test-id'),
        headers: {
          ...HEADERS,
          host: STUB_HOST,
          ...(auth === 'optional' ? { authorization: 'Bearer invalid-token' } : {}),
          ...(auth === 'login' ? { 'content-type': 'application/json' } : {}),
        },
        // Valid JSON larger than bodyLimit: stage ② must reject before any body is read.
        ...(auth === 'login' ? { payload: JSON.stringify('x'.repeat(62)) } : {}),
      });
      expect(matched, '请求必须路由到桩（而不是已实现的处理函数）').toHaveBeenCalledTimes(1);
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
