import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createTokenCheck } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { OrderSubject } from '../../../../apps/api/src/modules/orders/index.ts';
import { createSignatureCheck } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  FixedClock,
  REQUEST_CHECKS,
  createRootLogger,
  isContractSignedRoute,
  loadConfig,
  type DbHandles,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { redisConnection } from '../../identity/sms-codes/kit.ts';
import { NOW, value } from './kit.ts';

export const PATH = '/v1/orders/claims';
const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}
export interface Response {
  statusCode: number;
  body: string;
  json(): Envelope;
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
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(adapter: unknown, options: unknown): HttpApp }>;
}
interface Options {
  subject: OrderSubject;
  clock?: FixedClock;
  db?: Kysely<DB>;
  redisUrl?: string;
}
export interface SendOptions {
  key?: string;
  subject?: OrderSubject;
  headers?: Record<string, string>;
}
export type Send = (body?: object, options?: SendOptions, query?: string) => Promise<Response>;

/** Real module graph, controllers, validation, version gate and PG idempotency.
 * Only authentication dependencies and signature nonce storage are synthetic.
 * No orders provider is overridden; app startup is captured inside the test body. */
export async function withHttp(
  options: Options,
  run: (send: Send, logs: string[]) => Promise<void>,
) {
  const { NestFactory } = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { create(module: unknown, adapter: unknown, options: unknown): Promise<HttpApp> };
  };
  const { Test } = (await import(pathToFileURL(requireApi.resolve('@nestjs/testing')).href)) as {
    Test: { createTestingModule(meta: { imports: unknown[] }): Builder };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles?: DbHandles;
        redisUrl?: ReturnType<typeof redisConnection>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const clock = options.clock ?? new FixedClock(NOW);
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const actors = new Map<string, OrderSubject>();
  const signature = createSignatureCheck({
    clock,
    devices: {
      findActive: async () => ({ appId: options.subject.app_id, deviceId, installSecret: secret }),
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
      verifyAccess: async (token) => {
        const subject = actors.get(token)!;
        return {
          uid: subject.user_id,
          app_id: subject.app_id,
          sid: randomUUID(),
          device_id: deviceId,
          scp: 'full',
        };
      },
      issueAccess: async () => 'synthetic-access',
      issueRefresh: () => ({
        token: 'synthetic-refresh',
        hash: 'synthetic-hash',
        expireAt: clock.now(),
      }),
    },
    sessions: { find: async () => ({ revoked_at: null }) },
  });
  const spy = vi.spyOn(NestFactory, 'create').mockImplementation(async (module, adapter, opts) => {
    const builder = Test.createTestingModule({ imports: [module] });
    builder
      .overrideProvider(REQUEST_CHECKS)
      .useValue({ checks: [signature, tokenCheck], bufferWhen: isContractSignedRoute });
    return (await builder.compile()).createNestApplication(adapter, opts);
  });
  const logs: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await value(() =>
      createHttpApp('api', {
        config: loadConfig({ APP_ENV: 'test' }),
        clock,
        logger: createRootLogger(
          { entry: 'api', appEnv: 'test', level: 'info' },
          {
            write: (line) => {
              logs.push(line);
            },
          },
        ),
        ...(options.db
          ? { dbHandles: { db: options.db, dbRead: null, close: async () => undefined } }
          : {}),
        ...(options.redisUrl ? { redisUrl: redisConnection(options.redisUrl).redisUrl } : {}),
      }),
    );
    await app.init();
    const server = app;
    const send: Send = async (body, opts = {}, query = '') => {
      const subject = opts.subject ?? options.subject;
      const token = randomUUID();
      actors.set(token, subject);
      const raw = body === undefined ? '' : JSON.stringify(body);
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const method = body === undefined ? 'GET' : 'POST';
      const message = [
        method,
        PATH,
        timestamp,
        nonce,
        createHash('sha256').update(raw).digest('hex'),
      ].join('\n');
      const response = await server.inject({
        method,
        url: PATH + query,
        ...(body === undefined ? {} : { payload: raw }),
        headers: {
          authorization: `Bearer ${token}`,
          'x-app-id': subject.app_id,
          'x-device-id': deviceId,
          'x-platform': 'ios',
          'x-channel': 'appstore',
          'x-app-version': '2.0.0',
          'x-trace-id': randomUUID(),
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'idempotency-key': opts.key ?? randomUUID(),
                'x-timestamp': timestamp,
                'x-nonce': nonce,
                'x-sign': createHmac('sha256', secret).update(message).digest('hex'),
              }),
          ...opts.headers,
        },
      });
      if (response.statusCode === 200) await validate(response, method);
      return response;
    };
    await run(send, logs);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}

interface Operation {
  operationId: string;
  'x-implementation'?: string;
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
let doc: Promise<{ paths: Record<string, { get: Operation; post: Operation }> }> | undefined;
export function contract() {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): NonNullable<typeof doc>;
  };
  doc ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return doc;
}
export async function validate(response: Response, method: 'GET' | 'POST') {
  const operation = (await contract()).paths[PATH]![method === 'GET' ? 'get' : 'post'];
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = createValidatorCompiler()({
    schema: operation.responses[status]!.content['application/json']!.schema,
    httpPart: 'body',
  });
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function answer(
  response: Response,
  code: number,
  data?: object,
  method: 'GET' | 'POST' = 'POST',
) {
  expect(response.statusCode).toBe(
    code === 0
      ? 200
      : code === 20001
        ? 400
        : code === 30201
          ? 404
          : code === 50001
            ? 500
            : code === 10405
              ? 403
              : 422,
  );
  expect(response.json()).toMatchObject({ code, msg: expect.any(String) });
  if (code !== 0 && code !== 50001 && code !== 10405) {
    if (data === undefined) expect(response.json()).not.toHaveProperty('data');
    else expect(response.json().data).toEqual(data);
  }
  await validate(response, method);
}
