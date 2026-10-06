import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { CheckedRequest } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { makeDir } from '../../identity/devices/kit.ts';
import {
  NONCE,
  NOW,
  ROOT,
  TRACE,
  UNSIGNED_HEADERS,
  apiRequire,
  contract,
  input,
  rejected,
  sign,
  signingString,
  type Response,
  type RequestCheckServer,
} from './kit.ts';

interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  getHttpAdapter(): { getInstance(): RequestCheckServer };
}
let database: TestDatabase | undefined;
let db: Kysely<DB> | undefined;
let server: TestRedis | undefined;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as Record<
    string,
    unknown
  >;
  if (typeof testing['acquireTestRedis'] === 'function')
    server = await (testing['acquireTestRedis'] as () => Promise<TestRedis>)();
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    try {
      await database?.drop();
    } finally {
      await server?.stop();
    }
  }
});

async function withApp(
  run: (context: {
    app: App;
    http: RequestCheckServer;
    lines: string[];
    config: ReturnType<typeof loadConfig>;
    stubPath: string;
    registerDevice: (headers?: Record<string, string>) => ReturnType<typeof register>;
  }) => Promise<void>,
) {
  expect(server).toBeDefined();
  expect(db).toBeDefined();
  // Select inside each test, so an exhausted candidate list is an assertion failure,
  // not a beforeAll failure that prevents the rule assertions from running.
  const candidates = Object.entries((await contract()).paths)
    .filter(
      ([path, item]) =>
        !path.includes('{') &&
        item.post?.['x-signed'] === true &&
        typeof item.post.operationId === 'string' &&
        !Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, item.post.operationId),
    )
    .map(([path]) => path)
    .sort();
  expect(
    candidates.length,
    '没有可用作桩的未实现签名 POST 接口，改用别的测试办法',
  ).toBeGreaterThan(0);
  const stubPath = candidates[0]!;
  const directory = makeDir();
  const lines: string[] = [];
  const nonceKeys: string[] = [];
  let app: App | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(directory, 'signature-master.hex');
    const keyringFile = join(directory, 'signature-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const config = loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
    });
    app = await application(config, lines, stubPath);
    const http = app.getHttpAdapter().getInstance();
    await run({
      app,
      http,
      lines,
      config,
      stubPath,
      registerDevice: async (headers) => {
        const device = await register(http, headers);
        nonceKeys.push(`risk:nonce:couli:${device.device_id}:${NONCE}`);
        return device;
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        // Delete only this fixture's keys, including after a failed assertion.
        if (nonceKeys.length > 0) {
          const { Redis } = apiRequire('ioredis') as {
            Redis: new (
              url: string,
              options: object,
            ) => {
              call(command: string, ...args: string[]): Promise<unknown>;
              disconnect(): void;
            };
          };
          const raw = new Redis(server!.url, {
            maxRetriesPerRequest: 0,
            retryStrategy: () => null,
          });
          try {
            await raw.call('DEL', ...nonceKeys);
          } finally {
            raw.disconnect();
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}

async function application(
  config: ReturnType<typeof loadConfig>,
  lines: string[],
  stubPath: string,
  withoutRedis = false,
): Promise<App> {
  const bootstrap = new URL('apps/api/src/bootstrap.ts', ROOT).href;
  const { createHttpApp } = (await import(bootstrap)) as {
    createHttpApp(entry: 'api', overrides: object): Promise<App>;
  };
  const app = await createHttpApp('api', {
    config,
    clock: new FixedClock(new Date(NOW * 1000)),
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    ...(withoutRedis
      ? {}
      : {
          redisUrl: loadConnectionConfig('api', {
            DATABASE_URL: database!.urlFor('couli_app'),
            DATABASE_READ_URL: database!.urlFor('couli_readonly'),
            REDIS_URL: server!.url,
          }).redisUrl,
        }),
  });
  try {
    // Test-only route, no production registration of a planned operation; bootstrap itself
    // must attach stage ① and wire the real identity port (no manually supplied risk check).
    app
      .getHttpAdapter()
      .getInstance()
      .post(stubPath, (request) => ({
        reached: true,
        body: request.body,
        verifiedDevice: (request as CheckedRequest).verifiedDevice ?? null,
      }));
    await app.init();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function register(http: RequestCheckServer, headers: Record<string, string> = {}) {
  const response = await http.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: {
      'x-app-id': 'couli',
      'x-platform': 'ios',
      'x-app-version': '1.2.3',
      'x-trace-id': TRACE,
      ...headers,
    },
    payload: {
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    code: number;
    data: { device_id: string; install_secret: string };
  }>();
  expect(body.code).toBe(0);
  expect(body.data.device_id).toEqual(expect.any(String));
  expect(body.data.install_secret).toEqual(expect.any(String));
  return body.data;
}
function signed(
  http: RequestCheckServer,
  device: { device_id: string; install_secret: string },
  stubPath: string,
  nonce = NONCE,
): Promise<Response> {
  const request = input({ url: stubPath, routeTemplate: stubPath });
  return http.inject({
    method: 'POST',
    url: stubPath,
    payload: request.rawBody,
    headers: {
      ...request.headers,
      'x-device-id': device.device_id,
      'x-nonce': nonce,
      'x-sign': sign('POST', stubPath, request.rawBody, String(NOW), nonce, device.install_secret),
    },
  });
}

it('[BR-ID-09][04 §5] 真实应用healthz和设备注册无需签名；签发密钥可验签并阻止重放', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http, lines, stubPath, registerDevice }) => {
    expect(
      (await http.inject({ method: 'GET', url: '/healthz', headers: UNSIGNED_HEADERS })).statusCode,
    ).toBe(200);
    // BR-ID-09: re-registration must work even when common headers carry an unknown device.
    const device = await registerDevice(UNSIGNED_HEADERS);
    const response = await signed(http, device, stubPath);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reached: true,
      body: { phone: '13800138000', purpose: 'login' },
      verifiedDevice: { deviceId: device.device_id, appId: 'couli' },
    });
    await rejected(await signed(http, device, stubPath), 10401);
    expect(lines.join('')).not.toContain(device.install_secret);
  });
});

it('[BR-ID-09][BR-ID-01] DB无此设备或已吊销返回10402，优先于损坏JSON和签名', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http, stubPath, registerDevice }) => {
    const device = await registerDevice();
    // BR-ID-09 "未吊销": a successful lookup cannot authorize requests after revocation.
    expect((await signed(http, device, stubPath)).statusCode).toBe(200);
    await sql`UPDATE app.devices SET revoked_at = ${new Date(NOW * 1000)} WHERE id = ${device.device_id}::uuid`.execute(
      db!,
    );
    // BR-ID-09: a non-UUID cannot be server-issued; reject before querying a UUID column.
    for (const id of [device.device_id, randomUUID(), 'not-a-uuid', '']) {
      const response = await http.inject({
        method: 'POST',
        url: stubPath,
        payload: '{',
        headers: {
          'content-type': 'application/json',
          'x-device-id': id,
          'x-sign': 'bad',
          'x-trace-id': TRACE,
        },
      });
      await rejected(response, 10402);
    }
  });
});

it('[BR-ID-09][B1-01za] 密文损坏或复制到其他设备行导致解密失败，返回50001且不泄露签名素材', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http, lines, stubPath, registerDevice }) => {
    const first = await registerDevice();
    const second = await registerDevice();
    await sql`UPDATE app.devices SET install_secret_cipher = (SELECT install_secret_cipher FROM app.devices WHERE id = ${first.device_id}::uuid) WHERE id = ${second.device_id}::uuid`.execute(
      db!,
    );
    const secondResponse = await signed(http, second, stubPath);
    await rejected(secondResponse, 50001);
    await sql`UPDATE app.devices SET install_secret_cipher = ${Buffer.from('broken-ciphertext')} WHERE id = ${first.device_id}::uuid`.execute(
      db!,
    );
    const firstResponse = await signed(http, first, stubPath);
    await rejected(firstResponse, 50001);
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'unhandled_error', trace_id: TRACE }),
    );
    for (const device of [first, second]) {
      for (const secret of [
        device.install_secret,
        sign('POST', stubPath, input().rawBody, String(NOW), NONCE, device.install_secret),
        signingString('POST', stubPath, input().rawBody, String(NOW), NONCE),
      ]) {
        const escaped = JSON.stringify(secret).slice(1, -1);
        expect(lines.join('\n')).not.toContain(escaped);
        expect(firstResponse.body + secondResponse.body).not.toContain(escaped);
      }
    }
  });
});

it('[BR-ID-09][B1-01za] 服务端未配置字段加密密钥不能把已签发设备当作10402或放行', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ stubPath, registerDevice }) => {
    const device = await registerDevice();
    const missingKeyApp = await application(loadConfig({ APP_ENV: 'test' }), [], stubPath);
    try {
      await rejected(
        await signed(missingKeyApp.getHttpAdapter().getInstance(), device, stubPath),
        50001,
      );
    } finally {
      await missingKeyApp.close();
    }
  });
});

it('[BR-ID-09][BR-ID-01][ADR-0001 §4.2 第17项] 真实应用未传redisUrl时正确签名返回50001，缺设备仍先返回10402', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ config, stubPath, registerDevice }) => {
    const device = await registerDevice();
    const missingRedisApp = await application(config, [], stubPath, true);
    try {
      const http = missingRedisApp.getHttpAdapter().getInstance();
      await rejected(await signed(http, device, stubPath), 50001);
      await rejected(
        await http.inject({
          method: 'POST',
          url: stubPath,
          headers: { 'x-trace-id': TRACE, 'content-type': 'application/json' },
          payload: '{',
        }),
        10402,
      );
    } finally {
      await missingRedisApp.close();
    }
  });
});
