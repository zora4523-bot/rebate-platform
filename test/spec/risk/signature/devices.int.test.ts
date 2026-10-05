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
import { ConnectionUrl } from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { CheckedRequest } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { makeDir } from '../../identity/devices/kit.ts';
import {
  NONCE,
  NOW,
  ROOT,
  SMS,
  TRACE,
  input,
  rejected,
  sign,
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
  }) => Promise<void>,
) {
  expect(server).toBeDefined();
  expect(db).toBeDefined();
  const directory = makeDir();
  const lines: string[] = [];
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
    app = await application(config, lines);
    await run({ app, http: app.getHttpAdapter().getInstance(), lines, config });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function application(config: ReturnType<typeof loadConfig>, lines: string[]): Promise<App> {
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
    redisUrl: new ConnectionUrl(server!.url),
  });
  try {
    // Test-only route, no production registration of a planned operation; bootstrap itself
    // must attach stage ① and wire the real identity port (no manually supplied risk check).
    app
      .getHttpAdapter()
      .getInstance()
      .post(SMS, (request) => ({
        reached: true,
        verifiedDevice: (request as CheckedRequest).verifiedDevice ?? null,
      }));
    await app.init();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function register(http: RequestCheckServer) {
  const response = await http.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: {
      'x-app-id': 'couli',
      'x-platform': 'ios',
      'x-app-version': '1.2.3',
      'x-trace-id': TRACE,
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
  nonce = NONCE,
): Promise<Response> {
  const request = input();
  return http.inject({
    method: 'POST',
    url: SMS,
    payload: request.rawBody,
    headers: {
      ...request.headers,
      'x-device-id': device.device_id,
      'x-nonce': nonce,
      'x-sign': sign('POST', SMS, request.rawBody, String(NOW), nonce, device.install_secret),
    },
  });
}

it('[BR-ID-09][04 §5] 真实应用healthz和设备注册无需签名；签发密钥可验签并阻止重放', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http, lines }) => {
    expect((await http.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const device = await register(http);
    const response = await signed(http, device);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      reached: true,
      verifiedDevice: { deviceId: device.device_id, appId: 'couli' },
    });
    await rejected(await signed(http, device), 10401);
    expect(lines.join('')).not.toContain(device.install_secret);
  });
});

it('[BR-ID-09][BR-ID-01] DB无此设备或已吊销返回10402，优先于损坏JSON和签名', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http }) => {
    const device = await register(http);
    // Warm an implementation's lookup, then revoke: stale positive caching must not bypass it.
    expect((await signed(http, device)).statusCode).toBe(200);
    await sql`UPDATE app.devices SET revoked_at = ${new Date(NOW * 1000)} WHERE id = ${device.device_id}::uuid`.execute(
      db!,
    );
    for (const id of [device.device_id, randomUUID(), 'not-a-uuid', '']) {
      const response = await http.inject({
        method: 'POST',
        url: SMS,
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

it('[BR-ID-09][B1-03b §9.5] 密文损坏或复制到其他设备行导致解密失败，返回50001且不泄露签名素材', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http, lines }) => {
    const first = await register(http);
    const second = await register(http);
    await sql`UPDATE app.devices SET install_secret_cipher = (SELECT install_secret_cipher FROM app.devices WHERE id = ${first.device_id}::uuid) WHERE id = ${second.device_id}::uuid`.execute(
      db!,
    );
    await rejected(await signed(http, second), 50001);
    await sql`UPDATE app.devices SET install_secret_cipher = ${Buffer.from('broken-ciphertext')} WHERE id = ${first.device_id}::uuid`.execute(
      db!,
    );
    await rejected(await signed(http, first), 50001);
    const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'unhandled_error', trace_id: TRACE }),
    );
    for (const device of [first, second]) {
      expect(JSON.stringify(logs)).not.toContain(device.install_secret);
      expect(JSON.stringify(logs)).not.toContain(
        sign('POST', SMS, input().rawBody, String(NOW), NONCE, device.install_secret),
      );
    }
  });
});

it('[BR-ID-09][B1-03b §9.5] 服务端未配置字段加密密钥不能把已签发设备当作10402或放行', async () => {
  expect(server).toBeDefined();
  await withApp(async ({ http }) => {
    const device = await register(http);
    const missingKeyApp = await application(loadConfig({ APP_ENV: 'test' }), []);
    try {
      await rejected(await signed(missingKeyApp.getHttpAdapter().getInstance(), device), 50001);
    } finally {
      await missingKeyApp.close();
    }
  });
});
