import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  CatalogModule,
  ViewerContext,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CatalogSearchService } from '../../../../apps/api/src/modules/catalog/application/search-service.ts';
import {
  AttrCodeReader,
  CallerContext,
  LinkingModule,
  type Caller,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { LinkOpenService } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { fixture } from '../token/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';
import { assertContract } from '../../catalog/search-route/http-kit.ts';
import { seedUser } from './db-kit.ts';

const root = new URL('../../../../', import.meta.url);
const deps = fixture();
const headers = {
  'content-type': 'application/json',
  'x-app-id': 'couli',
  'x-platform': 'ios',
  'x-app-version': '2.0.0',
};
interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
interface Device {
  device_id: string;
  install_secret: string;
}
let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let redis: Awaited<ReturnType<(typeof import('@couli/db/testing'))['acquireTestRedis']>>;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let directory: string | undefined;
const viewers: Viewer[] = [];
const callers: Caller[] = [];
const attrReads: { appId: string; userId: string; value: string | null }[] = [];

beforeAll(async () => {
  const testing = await import('@couli/db/testing');
  database = await testing.createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await testing.acquireTestRedis();
  const base = fileURLToPath(new URL('.tmp/', root));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, 'b1-02m-'));
  // Ephemeral fixture material, following sms-codes/http-kit.ts; no real credentials are read.
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  const masterFile = join(directory, 'synthetic-master.hex');
  const keyringFile = join(directory, 'synthetic-keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });

  // Preserve every forRoot argument, especially the new optional port providers. Replace only
  // downstream use cases, never ViewerContext, CallerContext, AttrCodeReader or the guards.
  const catalog = CatalogModule.forRoot;
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((...args) => {
    const module = catalog(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter(
          (p) =>
            p !== CatalogSearchService &&
            !(typeof p === 'object' && p.provide === CatalogSearchService),
        ),
        {
          provide: CatalogSearchService,
          inject: [ViewerContext],
          useFactory: (context: ViewerContext): CatalogSearchService => ({
            async search() {
              viewers.push(await context.current());
              return { items: [], next_cursor: null, has_more: false, fallback_items: [] };
            },
          }),
        },
      ],
    };
  });
  const linking = LinkingModule.forRoot;
  vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
    const module = linking(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter(
          (p) => p !== LinkOpenService && !(typeof p === 'object' && p.provide === LinkOpenService),
        ),
        {
          provide: LinkOpenService,
          inject: [CallerContext, AttrCodeReader],
          useFactory: (context: CallerContext, reader: AttrCodeReader): LinkOpenService => ({
            async open(input) {
              const caller = await context.current();
              callers.push(caller);
              if (caller.userId !== null) {
                attrReads.push({
                  appId: caller.appId,
                  userId: caller.userId,
                  value: await reader.attrCode(caller.appId, caller.userId),
                });
              }
              // No link or external conversion is needed to observe identity at the boundary.
              return {
                status: 404,
                envelope: { code: 30144, msg: '链接不存在', trace_id: input.traceId },
              };
            },
          }),
        },
      ],
    };
  });

  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: typeof deps.clock;
        logger: ReturnType<typeof createRootLogger>;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  app = await createHttpApp('api', {
    config: loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  });
  await app.init();
}, 180_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    vi.restoreAllMocks();
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  }
});

async function registerDevice(appId = 'couli'): Promise<Device> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'x-app-id': appId },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: { device_id: expect.any(String), install_secret: expect.any(String) },
  });
  return response.json<{ data: Device }>().data;
}

async function session(appId: string, device: Device) {
  const user = await seedUser(db, appId);
  const issued = await db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        uid: user.id,
        app_id: appId,
        device_id: device.device_id,
        scp: 'full',
      },
      deps,
    ),
  );
  return { user, issued };
}

function open(device: Device, token?: string) {
  const path = `/v1/links/${randomUUID()}/open`;
  const payload = '{}';
  const timestamp = String(Math.floor(deps.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return app!.inject({
    method: 'POST',
    url: path,
    payload,
    headers: {
      ...headers,
      'x-device-id': device.device_id,
      'idempotency-key': randomUUID(),
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign('POST', path, Buffer.from(payload), timestamp, nonce, device.install_secret),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

function search(device: Device, token?: string) {
  return app!.inject({
    method: 'GET',
    url: '/v1/products/search?platform=taobao&q=test',
    headers: {
      ...headers,
      'x-device-id': device.device_id,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

it('[AC-B1-02m#10] 真实 AppModule：登录与游客端口隔离，联盟归因读 attr_code，他 App 令牌在端口调用前被拒绝', async () => {
  const deviceA = await registerDevice();
  const deviceB = await registerDevice();
  const first = await session('couli', deviceA);
  const second = await session('couli', deviceB);
  const foreignDevice = await registerDevice('couli_other');
  const foreign = await session('couli_other', foreignDevice);
  const validError = await envelopeValidator();

  // Alternation also catches singleton providers retaining the first authenticated identity.
  for (const account of [first, second, undefined, first]) {
    const token = account?.issued.access_token;
    const expected = {
      appId: 'couli',
      userId: account?.user.id ?? null,
      deviceId:
        account === first ? deviceA.device_id : account === second ? deviceB.device_id : null,
    };
    // Search is unsigned in the contract: an anonymous raw device header is not verified.
    const result = await search(deviceB, token);
    expect(result.statusCode).toBe(200);
    await assertContract(result, true);
    expect(viewers.at(-1)).toEqual(expected);

    const readsBefore = attrReads.length;
    const opened = await open(deviceB, token);
    expect(opened.statusCode).toBe(404);
    expect(validError(opened.json())).toBe(true);
    expect(opened.json()).toMatchObject({ code: 30144 });
    expect(callers.at(-1)).toEqual({
      ...expected,
      deviceId: account === undefined ? deviceB.device_id : expected.deviceId,
    });
    if (account === undefined) {
      expect(attrReads).toHaveLength(readsBefore);
    } else {
      expect(attrReads).toHaveLength(readsBefore + 1);
      expect(attrReads.at(-1)).toEqual({
        appId: 'couli',
        userId: account.user.id,
        value: account.user.attrCode,
      });
      expect(attrReads.at(-1)!.value).not.toBe(account.user.id);
    }
  }

  const before = { viewers: viewers.length, callers: callers.length, attrs: attrReads.length };
  for (const rejected of [
    await search(deviceB, foreign.issued.access_token),
    await open(deviceB, foreign.issued.access_token),
  ]) {
    expect(rejected.statusCode).toBe(403);
    expect(validError(rejected.json())).toBe(true);
    expect(rejected.json()).toMatchObject({ code: 10403 });
  }
  expect({ viewers: viewers.length, callers: callers.length, attrs: attrReads.length }).toEqual(
    before,
  );
});
