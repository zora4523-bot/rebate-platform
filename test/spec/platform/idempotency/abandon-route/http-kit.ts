// B1-02g §9: real AppModule, business-role PG, real device signatures and persisted sessions.
// Only the orchestrator runs these fixtures, inside the isolated integration-test container.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../../apps/api/src/modules/platform/config/index.ts';
import type { Idempotency } from '../../../../../apps/api/src/modules/platform/idempotency/index.ts';
import type { TokenService } from '../../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  createValidatorCompiler,
  type ContractOperation,
  type JsonSchema,
} from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { openKit, closeKit, seedUser } from '../../../identity/registration/kit.ts';
import { buildApp, type HttpApp, type Response } from '../../../identity/sms-codes/http-kit.ts';
import { acquireRedis, memoryLogger } from '../../../identity/sms-codes/kit.ts';
import { apiRequire, ROOT, sign } from '../../../risk/signature/kit.ts';

export const PATH = '/v1/idempotency-keys/abandon';
export const ACTIONS = [
  { action: 'withdraw', method: 'POST', path: '/v1/withdrawals' },
  { action: 'payout_account_change', method: 'PUT', path: '/v1/me/payout-account' },
  { action: 'phone_change', method: 'POST', path: '/v1/me/phone' },
  { action: 'account_deletion', method: 'POST', path: '/v1/me/deletion' },
] as const;
export type Operation = (typeof ACTIONS)[number];
export interface WireResponse extends Response {
  readonly payload: string;
}
interface App extends HttpApp {
  inject(request: Parameters<HttpApp['inject']>[0]): Promise<WireResponse>;
  getHttpAdapter(): {
    getInstance(): {
      ready(): Promise<void>;
      hasRoute(route: { method: 'POST'; url: string }): boolean;
    };
  };
}
export interface OperationContract extends ContractOperation {
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
export async function contract(): Promise<OperationContract> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { post: OperationContract }>;
    }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  return doc.paths[PATH]!.post;
}

export async function openHttp() {
  const kit = await openKit(); // Database testing helper is dynamically imported by openKit.
  const server = await acquireRedis();
  expect(server).toBeDefined();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'spec-b1-02g-'));
  const clock = new FixedClock('2026-10-08T04:00:00.000Z');
  const { logger, lines } = memoryLogger();
  let app: App | undefined;
  try {
    app = (await buildApp(kit.db, dir, server!.url, clock, logger)) as App;
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // The existing DI token is loaded dynamically to keep Nest decorators out of test's
    // erasable-only TypeScript project. No dependency on the new controller's filename.
    const platform = (await import(
      new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
    )) as { IDEMPOTENCY: symbol };
    const idem = app.get<Idempotency>(platform.IDEMPOTENCY);
    const operation = await contract();
    const compile = createValidatorCompiler();
    const validators = {
      success: compile({
        schema: operation.responses['200']!.content['application/json']!.schema,
        httpPart: 'body',
      }),
      error: compile({
        schema: operation.responses['4XX']!.content['application/json']!.schema,
        httpPart: 'body',
      }),
    };
    return {
      ...kit,
      app,
      idem,
      clock,
      lines,
      logger,
      validators,
      async close() {
        try {
          await app?.close();
        } finally {
          try {
            await server!.stop();
          } finally {
            await closeKit(kit);
            rmSync(dir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await app?.close();
    await server!.stop();
    await closeKit(kit);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof openHttp>>;

export async function client(f: Fixture, appId = 'couli') {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-channel': 'appstore',
  };
  const registered = await f.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(registered.statusCode).toBe(200);
  const { data } = registered.json<{ data: { device_id: string; install_secret: string } }>();
  expect(data).toMatchObject({ device_id: expect.any(String), install_secret: expect.any(String) });
  const uid = await seedUser(f.db, appId);
  const tokens = f.app.get<TokenService>(TOKEN_SERVICE);
  const session = await f.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: appId, device_id: data.device_id, scp: 'full' },
        { clock: f.clock, tokens },
      ),
    );
  return {
    uid,
    appId,
    token: session.access_token,
    send(
      body: Record<string, unknown>,
      options: { token?: string | null; headers?: Record<string, string>; trace?: string } = {},
    ) {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(f.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      const token = options.token === undefined ? session.access_token : options.token;
      return f.app.inject({
        method: 'POST',
        url: PATH,
        payload: raw,
        headers: {
          ...headers,
          'x-device-id': data.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', PATH, Buffer.from(raw), timestamp, nonce, data.install_secret),
          'x-trace-id': options.trace ?? randomUUID(),
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...options.headers,
        },
      });
    },
  };
}
export type Client = Awaited<ReturnType<typeof client>>;
export function rows(f: Fixture, key: string) {
  return f.db
    .withSchema('app')
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('key', '=', key)
    .orderBy('id')
    .execute();
}
export function originalRequest(c: Client, op: Operation, key: string) {
  return {
    appId: c.appId,
    actor: { userId: c.uid, deviceId: null, phoneHmac: null },
    method: op.method,
    path: op.path,
    key,
    body: { fixture: 'original-sensitive-operation' },
    traceId: randomUUID(),
  };
}
export function accepted(f: Fixture, response: WireResponse, data: unknown, trace?: string) {
  expect(response.statusCode).toBe(200);
  expect(f.validators.success(response.json())).toBe(true);
  expect(f.validators.success.errors ?? []).toEqual([]);
  expect(response.json()).toEqual({
    code: 0,
    msg: '',
    data,
    trace_id: trace ?? expect.any(String),
  });
  expect(response.headers['x-trace-id']).toBe(response.json<{ trace_id: string }>().trace_id);
}
export function rejected(f: Fixture, response: WireResponse, status: number, code: number) {
  expect(response.statusCode).toBe(status);
  expect(f.validators.error(response.json())).toBe(true);
  expect(f.validators.error.errors ?? []).toEqual([]);
  expect(response.json()).toMatchObject({
    code,
    msg: expect.any(String),
    trace_id: expect.any(String),
  });
}
export async function entryApp(
  f: Fixture,
  entry: 'api' | 'admin' | 'stream',
  withDatabase = false,
) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: string, overrides: object): Promise<App>;
  };
  return createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: f.clock,
    logger: f.logger,
    ...(withDatabase
      ? { dbHandles: { db: f.db, dbRead: null, close: async () => undefined } }
      : {}),
  });
}
