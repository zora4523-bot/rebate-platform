// Wiring of stage ① in the real api entry (bootstrap → REQUEST_CHECKS → RiskModule → identity's
// DeviceSigningKeys port), with an in-memory database, field cipher and Redis. A planned signed
// operation has no production route (contract.test.ts), so a test route stands on one: a Fastify
// route added before init, or a Nest controller of this file. The operation is picked from the
// contract at run time, as test/spec/risk/signature/devices.int.test.ts does, so that implementing
// an operation never makes this file collide with its real route.
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Body, Controller, Post, Req, type DynamicModule, type Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module.ts';
import { createHttpApp } from '../../bootstrap.ts';
import {
  DB,
  FIELD_CRYPTO,
  FixedClock,
  REDIS,
  contractRouteSchema,
  createRootLogger,
  loadConfig,
  type CheckedRequest,
  type ContractOperationId,
  type FieldCrypto,
  type RedisHandle,
  type RedisNamespace,
} from '../platform/index.ts';

const NOW = 1790661600;
const TRACE = 'b103b0000000000000000000000000aa';
const DEVICE = '019a0000-0000-7000-8000-0000000000d1';
const REVOKED = '019a0000-0000-7000-8000-0000000000d2';
const SECRET = 'test-only.risk-wiring.secret';
const NONCE = 'c3'.repeat(16);
const BODY = '{"phone":"13800138000","purpose":"login"}';

/** True when the api entry mounts the operation (it has a generated route schema). */
function implemented(operationId: string): boolean {
  try {
    contractRouteSchema(operationId as ContractOperationId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signed POST operations where stage ① is the only gate and no production route exists: no path
 * parameter, x-signed, x-auth none (the token stages hang on the same registration point), not
 * idempotent, no minimum-version gate, still planned (and without a generated route schema).
 * Sorted by path; the first one carries the test route.
 */
async function stubCandidates(): Promise<string[]> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return Object.entries(document.paths ?? {})
    .filter(([path, item]) => {
      const post = item?.post as
        (OpenAPIV3_1.OperationObject & Record<string, unknown>) | undefined;
      return (
        post !== undefined &&
        !path.includes('{') &&
        post['x-signed'] === true &&
        post['x-auth'] === 'none' &&
        post['x-idempotent'] !== true &&
        post['x-min-version-gate'] === false &&
        'x-implementation' in post &&
        typeof post.operationId === 'string' &&
        !implemented(post.operationId)
      );
    })
    .map(([path]) => path)
    .sort();
}
const CANDIDATES = await stubCandidates();
/** The test route's path; build() fails the test when the contract leaves no candidate. */
const STUB = CANDIDATES[0] ?? '/no-planned-signed-operation';

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

const context = (id: string): string => `devices.install_secret:${id}`;

/** devices rows for the identity repository's select chain; revoked rows are left out. */
function fakeDb() {
  const rows = new Map([
    [DEVICE, { revoked: false }],
    [REVOKED, { revoked: true }],
  ]);
  const lookups: string[] = [];
  const db = {
    selectFrom: () => {
      const conditions: unknown[][] = [];
      const query = {
        select: () => query,
        where: (...condition: unknown[]) => {
          conditions.push(condition);
          return query;
        },
        executeTakeFirst: async () => {
          const id = String(conditions.find((condition) => condition[0] === 'id')?.[2]);
          lookups.push(id);
          const unrevokedOnly = conditions.some(
            (condition) => condition[0] === 'revoked_at' && condition[1] === 'is',
          );
          const row = rows.get(id);
          if (row === undefined || (row.revoked && unrevokedOnly)) return undefined;
          return {
            id,
            app_id: 'couli',
            install_secret_cipher: Buffer.from(`${context(id)}|${SECRET}`),
          };
        },
      };
      return query;
    },
  };
  return { db, lookups };
}

function fakeCrypto(): FieldCrypto {
  const unused = (): never => {
    throw new Error('not used by request signatures');
  };
  return {
    currentKeyVersion: 1,
    encrypt: unused,
    decrypt: (ciphertext, cipherContext) => {
      if (!ciphertext.startsWith(`${cipherContext}|`)) throw new Error('decryption failed');
      return ciphertext.slice(cipherContext.length + 1);
    },
    keyVersionOf: unused,
    needsReencrypt: unused,
    reencrypt: unused,
    blindIndex: unused,
  };
}

function fakeRedis() {
  const reserved = new Set<string>();
  const evalScript = vi.fn(async (_script: string, options: { keys: readonly string[] }) => {
    const key = options.keys.join('|');
    if (reserved.has(key)) return null;
    reserved.add(key);
    return 'OK';
  });
  const ns: RedisNamespace = {
    eval: evalScript,
    get: async () => null,
    set: async () => {
      throw new Error('nonce reservation must be atomic');
    },
  };
  const handle: RedisHandle = {
    namespace: vi.fn(() => ns),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { handle, evalScript };
}

/** A Nest route on the signed contract template of `path` (test only). */
function signedProbeController(path: string): Type {
  @Controller()
  class SignedProbeController {
    @Post(path)
    send(@Body() body: unknown, @Req() request: CheckedRequest) {
      return { reached: true, body, verifiedDevice: request.verifiedDevice ?? null };
    }
  }
  return SignedProbeController;
}

/** Absolute-form request target of a request sent with this header (see build). */
const ABSOLUTE_FORM = 'x-test-absolute-form';
const AUTHORITY = 'https://api.example.com';

async function build(redis?: RedisHandle, options: { nest?: boolean } = {}) {
  expect(
    CANDIDATES.length,
    'no planned signed POST operation left to carry the test route',
  ).toBeGreaterThan(0);
  const { db, lookups } = fakeDb();
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((entryOptions) => {
    const root = original(entryOptions);
    const fakes: DynamicModule = {
      module: class FakeInfraModule {},
      global: true,
      providers: [
        { provide: DB, useValue: db },
        { provide: FIELD_CRYPTO, useValue: fakeCrypto() },
        ...(redis === undefined ? [] : [{ provide: REDIS, useValue: redis }]),
      ],
      exports: [DB, FIELD_CRYPTO, ...(redis === undefined ? [] : [REDIS])],
    };
    return {
      ...root,
      imports: [...(root.imports ?? []), fakes],
      ...(options.nest === true
        ? { controllers: [...(root.controllers ?? []), signedProbeController(STUB)] }
        : {}),
    };
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock(new Date(NOW * 1000)),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  const server = app.getHttpAdapter().getInstance();
  // light-my-request always sends the origin form. After routing, this hook leaves a request as
  // Node's HTTP parser hands Fastify an absolute-form target: route matched by its path,
  // request.raw.url holding scheme, authority, path and query.
  server.addHook('onRequest', async (request) => {
    if (request.headers[ABSOLUTE_FORM] !== undefined) {
      request.raw.url = `${AUTHORITY}${request.raw.url ?? ''}`;
    }
  });
  if (options.nest !== true) {
    server.post(STUB, (request) => ({
      reached: true,
      body: request.body ?? null,
      verifiedDevice: (request as CheckedRequest).verifiedDevice ?? null,
    }));
  }
  await app.init();
  return { app, lookups };
}

function signature(signedTarget: string, payload: string, nonce = NONCE): string {
  const bodyHash = createHash('sha256').update(payload).digest('hex');
  return createHmac('sha256', SECRET)
    .update(['POST', signedTarget, String(NOW), nonce, bodyHash].join('\n'))
    .digest('hex');
}

function signed(target: NestFastifyApplication, device = DEVICE, payload = BODY) {
  return target.inject({
    method: 'POST',
    url: STUB,
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      'x-device-id': device,
      'x-timestamp': String(NOW),
      'x-nonce': NONCE,
      'x-sign': signature(STUB, payload),
    },
    payload,
  });
}

it('[BR-ID-09][BR-ID-01] the api entry runs stage ① with the identity port and Redis nonces before parsing', async () => {
  const redis = fakeRedis();
  const { app: target, lookups } = await build(redis.handle);
  const response = await signed(target);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    reached: true,
    body: { phone: '13800138000', purpose: 'login' },
    verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
  });
  expect(redis.handle.namespace).toHaveBeenCalledWith('risk');
  expect(redis.evalScript).toHaveBeenCalledWith(
    expect.stringContaining('NX'),
    expect.objectContaining({ keys: [`nonce:couli:${DEVICE}:${NONCE}`], ttlSeconds: 600 }),
  );
  const replay = await signed(target);
  expect(replay.statusCode).toBe(401);
  expect(replay.json()).toMatchObject({ code: 10401, trace_id: TRACE });
  // A revoked device is 10402 before its broken JSON is parsed.
  const revoked = await signed(target, REVOKED, '{');
  expect(revoked.statusCode).toBe(401);
  expect(revoked.json()).toMatchObject({ code: 10402, trace_id: TRACE });
  expect(revoked.json()).not.toHaveProperty('data');
  expect(lookups).toEqual([DEVICE, DEVICE, REVOKED]);
  // A value the server cannot have issued is refused without a query.
  const forged = await signed(target, 'forged-device');
  expect(forged.json()).toMatchObject({ code: 10402 });
  expect(lookups).toHaveLength(3);
  // Unsigned routes are untouched.
  expect((await target.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
});

it('[BR-ID-09][ADR-0001 §4.2 第17项] without REDIS the api entry fails a valid signature closed and still answers 10401', async () => {
  const { app: target } = await build();
  const response = await signed(target);
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({ code: 50001, msg: '服务端错误', trace_id: TRACE });
  const bad = await target.inject({
    method: 'POST',
    url: STUB,
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      'x-device-id': DEVICE,
      'x-timestamp': String(NOW),
      'x-nonce': NONCE,
      'x-sign': '0'.repeat(64),
    },
    payload: BODY,
  });
  expect(bad.statusCode).toBe(401);
  expect(bad.json()).toMatchObject({ code: 10401, trace_id: TRACE });
});

it('[BR-ID-09] an absolute-form request target is verified on its origin form: path and raw query, no scheme or host', async () => {
  const { app: target } = await build(fakeRedis().handle);
  const url = `${STUB}?b=2&a=%2f`;
  const send = (sign: string, nonce: string) =>
    target.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-trace-id': TRACE,
        [ABSOLUTE_FORM]: '1',
        'x-device-id': DEVICE,
        'x-timestamp': String(NOW),
        'x-nonce': nonce,
        'x-sign': sign,
      },
      payload: BODY,
    });
  const accepted = await send(signature(url, BODY), NONCE);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({
    reached: true,
    verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
  });
  // Signed over the whole absolute target (path_domain of specs/request-sign.vectors.json).
  const withDomain = 'd4'.repeat(16);
  const refused = await send(signature(`${AUTHORITY}${url}`, BODY, withDomain), withDomain);
  expect(refused.statusCode).toBe(401);
  expect(refused.json()).toEqual({
    code: 10401,
    msg: '请求签名无效或重放（X-Nonce 重复 / 时间戳超窗）',
    trace_id: TRACE,
  });
  const wrong = 'e5'.repeat(16);
  const forged = await send('0'.repeat(64), wrong);
  expect(forged.statusCode).toBe(401);
  expect(forged.json()).toMatchObject({ code: 10401, trace_id: TRACE });
});

it('[BR-ID-09][BR-ID-01] stage ① also covers a route a Nest controller registers on a signed template', async () => {
  const redis = fakeRedis();
  const { app: target, lookups } = await build(redis.handle, { nest: true });
  const missing = await target.inject({
    method: 'POST',
    url: STUB,
    headers: { 'content-type': 'application/json', 'x-trace-id': TRACE },
    payload: '{',
  });
  expect(missing.statusCode).toBe(401);
  expect(missing.json()).toEqual({
    code: 10402,
    msg: '设备未注册、已失效或非服务端签发',
    trace_id: TRACE,
  });
  expect(lookups).toEqual([]);
  const accepted = await signed(target);
  expect(accepted.statusCode).toBe(201);
  expect(accepted.json()).toEqual({
    reached: true,
    body: { phone: '13800138000', purpose: 'login' },
    verifiedDevice: { deviceId: DEVICE, appId: 'couli' },
  });
  expect(redis.evalScript).toHaveBeenCalledTimes(1);
});

it('[BR-ID-09][B1-01za] a correct signature over the bytes received still answers 400 / 20001 when Content-Length disagrees', async () => {
  const { app: target } = await build(fakeRedis().handle);
  const response = await target.inject({
    method: 'POST',
    url: STUB,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(BODY) + 5),
      'x-trace-id': TRACE,
      'x-device-id': DEVICE,
      'x-timestamp': String(NOW),
      'x-nonce': NONCE,
      'x-sign': signature(STUB, BODY),
    },
    payload: BODY,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    code: 20001,
    msg: '参数校验失败',
    data: { fields: ['body'] },
    trace_id: TRACE,
  });
});
