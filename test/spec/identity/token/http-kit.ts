import { vi } from 'vitest';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { tokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import { installRequestChecks } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  createValidatorCompiler,
  routeSchemaOf,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { isContractSignedRoute } from '../../../../apps/api/src/modules/platform/validation/signing-routes.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import { dependencies, ROOT, TRACE, type RequestCheckServer } from '../../risk/signature/kit.ts';
import { fixture, routeFor, routes } from './kit.ts';

/** Independent Fastify instance, production check registration point and production error filter. */
export async function httpFixture() {
  const setup = fixture();
  const signatureDeps = dependencies();
  setup.clock.set(signatureDeps.clock.now());
  const signature = createSignatureCheck(signatureDeps);
  const check = createTokenCheck({
    tokens: setup.tokens,
    sessions: {
      find: async () => ({
        revoked_at: null,
      }),
    },
  });
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const errorModule = new URL('apps/api/src/modules/platform/http/global-errors.ts', ROOT).href;
  const { PlatformFastifyAdapter, GlobalErrorFilter } = (await import(errorModule)) as {
    PlatformFastifyAdapter: new (options: object) => { getInstance(): RequestCheckServer };
    GlobalErrorFilter: new (
      adapter: unknown,
      logger: unknown,
    ) => { catch(error: unknown, host: unknown): void };
  };
  const adapter = new PlatformFastifyAdapter({
    loggerInstance: logger,
    bodyLimit: 256,
    genReqId: () => TRACE,
    rewriteUrl: (req: { url: string; headers: Record<string, string | string[] | undefined> }) =>
      typeof req.headers['x-test-raw-target'] === 'string'
        ? req.headers['x-test-raw-target']
        : req.url,
  });
  const server = adapter.getInstance();
  const handled = vi.fn((req: object) => ({ principal: tokenPrincipal(req) ?? null }));
  try {
    const filter = new GlobalErrorFilter(adapter, logger);
    server.setErrorHandler((error, req, reply) =>
      filter.catch(error, {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
        getArgByIndex: (index: number) => [req, reply][index],
      }),
    );
    server.setValidatorCompiler(createValidatorCompiler());
    server.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-trace-id', TRACE);
      return payload;
    });
    // bufferWhen selects raw-body buffering; header-only ②③ must still run on unsigned routes.
    installRequestChecks(server, [signature, check], isContractSignedRoute);
    const signedLogin = await routeFor('login', true);
    for (const route of await routes())
      server.route({
        method: route.method,
        url: route.path,
        ...(route.path === '/v1/auth/logout' ||
        (route.method === signedLogin.method && route.path === signedLogin.path)
          ? { schema: routeSchemaOf(route.operation, route.parameters) }
          : {}),
        handler: handled,
      });
    await server.ready();
    return { ...setup, server, handled, lines, signatureDeps };
  } catch (error) {
    await server.close();
    throw error;
  }
}
