import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { PendingTracks, type OrderSubject } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  type DbHandles,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import { capture, START, at, attempt, card } from './kit.ts';
import { validate } from './schema-kit.ts';

export const traceId = '0199a3b4-5c6d-7000-8000-000000000099';
export const sample = card(attempt(1));
export function fakeQueries() {
  return {
    list: vi.fn<PendingTracks['list']>(async () => ({ items: [sample] })),
    dismiss: vi.fn<PendingTracks['dismiss']>(async () => undefined),
  };
}
export interface Response {
  statusCode: number;
  body: string;
  json(): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
interface TestingBuilder {
  overrideProvider(token: unknown): { useValue(value: unknown): TestingBuilder };
  compile(): Promise<{
    createNestApplication(adapter: unknown, options: unknown): HttpApp;
  }>;
}
export type Send = (
  url: string,
  body?: object,
  headers?: Record<string, string | undefined>,
) => Promise<Response>;

/** Real bootstrap and token middleware; only the read port and token dependencies are replaced. */
export async function withHttp(
  queries: PendingTracks | undefined,
  subject: OrderSubject,
  check: (send: Send, logs: string[]) => Promise<void>,
  dbHandles?: DbHandles,
  suppliedClock?: FixedClock,
) {
  const root = new URL('../../../../', import.meta.url);
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const { NestFactory } = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      create(module: unknown, adapter: unknown, options: unknown): Promise<HttpApp>;
    };
  };
  const { Test } = (await import(pathToFileURL(requireApi.resolve('@nestjs/testing')).href)) as {
    Test: { createTestingModule(metadata: { imports: unknown[] }): TestingBuilder };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles?: DbHandles;
      },
    ): Promise<HttpApp>;
  };
  const clock = suppliedClock ?? new FixedClock(START);
  if (suppliedClock === undefined) clock.set(at(20));
  const deviceId = randomUUID();
  const signingMaterial = randomBytes(32).toString('hex');
  // Keep the real signature check for the api entry's signed-route startup guard.
  // Order GET routes are unsigned; signing keys and nonce storage remain synthetic.
  const signature = createSignatureCheck({
    clock,
    devices: {
      findActive: async () => ({ appId: subject.app_id, deviceId, installSecret: signingMaterial }),
    },
    redis: {
      namespace: () => ({
        get: async () => null,
        set: async () => undefined,
        eval: async () => 'OK',
      }),
    },
  });
  const tokenCheck = createTokenCheck({
    tokens: {
      verifyAccess: async () => ({
        uid: subject.user_id,
        app_id: subject.app_id,
        sid: randomUUID(),
        device_id: deviceId,
        scp: 'full',
      }),
      issueAccess: async () => 'synthetic-access',
      issueRefresh: () => ({
        token: 'synthetic-refresh',
        hash: 'synthetic-hash',
        expireAt: clock.now(),
      }),
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  // Compile the actual production module graph, then override by provider token. This works
  // for static imports and dynamic modules regardless of when forRoot() was evaluated.
  // With queries omitted the real PendingTracks provider and all linking wiring stay intact.
  const factorySpy = vi
    .spyOn(NestFactory, 'create')
    .mockImplementation(async (module, adapter, options) => {
      const builder = Test.createTestingModule({ imports: [module] });
      builder.overrideProvider(REQUEST_CHECKS).useValue({
        checks: [signature, tokenCheck],
        bufferWhen: isContractSignedRoute,
      });
      if (queries !== undefined) builder.overrideProvider(PendingTracks).useValue(queries);
      const compiled = await builder.compile();
      return compiled.createNestApplication(adapter, options);
    });
  let app: HttpApp | undefined;
  const logs: string[] = [];
  try {
    const created = await capture(() =>
      createHttpApp('api', {
        config: loadConfig({ APP_ENV: 'test' }),
        clock,
        ...(dbHandles === undefined ? {} : { dbHandles }),
        logger: createRootLogger(
          { entry: 'api', appEnv: 'test', level: 'info' },
          {
            write: (line) => {
              logs.push(line);
            },
          },
        ),
      }),
    );
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw created.error;
    app = created.value;
    await app.init();
    const server = app;
    const send: Send = async (url, body, overrides = {}) => {
      const headers: Record<string, string> = {
        authorization: 'Bearer synthetic-access',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-app-id': subject.app_id,
        'x-platform': 'ios',
        'x-app-version': '1.0.0',
        'x-channel': 'appstore',
        'x-device-id': deviceId,
        'x-trace-id': traceId,
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete headers[name];
        else headers[name] = value;
      }
      const response = await server.inject({
        method: body === undefined ? 'GET' : 'POST',
        url,
        headers,
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      if (response.statusCode === 200) {
        await validate(
          response.json(),
          body === undefined ? 'PendingTracksResponse' : 'EmptyResponse',
        );
      }
      return response;
    };
    // Reject-path tests must prove the implemented route exists first, so planned 404 is red.
    expect((await send('/v1/orders/pending-tracks')).statusCode).toBe(200);
    await check(send, logs);
  } finally {
    factorySpy.mockRestore();
    await app?.close();
  }
}
