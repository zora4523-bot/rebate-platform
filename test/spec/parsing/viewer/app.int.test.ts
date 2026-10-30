import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  DemoUnionAdapter,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { seedUser } from '../../identity/request-context/db-kit.ts';
import { fixture } from '../../identity/token/kit.ts';
import { sign } from '../../risk/signature/kit.ts';
import { contract, PATH, TRACE, validResponse, type HttpApp } from '../http/kit.ts';

const root = new URL('../../../../', import.meta.url);
const deps = fixture();
const appId = `synthetic_view_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const productKey = 'tb:synthetic001';
const rawItemId = 'synthetic-parse-synthetic001';
const parseUrl = 'https://tb.example.test/item/synthetic001';
const headers = {
  'content-type': 'application/json',
  'x-app-id': appId,
  'x-platform': 'ios',
  'x-app-version': '2.0.0',
  'x-trace-id': TRACE,
};
const item: UnionItemDetail = {
  platform: 'taobao',
  item_id: rawItemId,
  title: '合成查看者商品',
  price_fen: 3990n,
  coupon_fen: 1000n,
  final_price_fen: 2990n,
  commission_rate_bp: 2000n,
  quoted_at: deps.clock.now().toISOString(),
  coupon_ids: 'synthetic-coupon',
};

interface Device {
  device_id: string;
  install_secret: string;
}

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let directory: string | undefined;
let schemas: Awaited<ReturnType<typeof contract>>;
const quotedViewers: catalog.Viewer[] = [];

beforeAll(async () => {
  schemas = await contract();
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  const base = fileURLToPath(new URL('.tmp/', root));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, 'b1-07c-'));
  // Ephemeral fixture material, as identity's request-context test; no real credentials are read.
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  const masterFile = join(directory, 'synthetic-master.hex');
  const keyringFile = join(directory, 'synthetic-keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });

  // Synthetic union DTOs only. Controllers, request checks, identity, card assembly and link
  // persistence stay real.
  vi.spyOn(DemoUnionAdapter.prototype, 'getItem').mockResolvedValue(item);
  vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink').mockResolvedValue({
    item: { platform: 'taobao', item_id: rawItemId },
  });
  vi.spyOn(platform, 'getLinkPatterns').mockReturnValue({
    version: 'synthetic-viewer',
    rules: [
      {
        platform: 'taobao',
        category: 'product',
        hosts: ['tb.example.test'],
        path_patterns: ['/item/*'],
      },
    ],
  });
  // links.user_id comes from linking's own CallerContext, which is identity's already: only the
  // viewer the process quoter receives tells whether the route took identity's ViewerContext
  // (parsingPorts), so the demo quoter is wrapped to record it and still does its real work.
  const demoQuoter = catalog.createDemoRebateQuoter;
  const quoters = vi.spyOn(catalog, 'createDemoRebateQuoter').mockImplementation((options) => {
    const quoter = demoQuoter(options);
    return {
      quote: (quoted, viewer, context) => {
        quotedViewers.push(viewer);
        return quoter.quote(quoted, viewer, context);
      },
    };
  });

  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: platform.AppConfig;
        clock: typeof deps.clock;
        logger: ReturnType<typeof platform.createRootLogger>;
        dbHandles: platform.DbHandles;
        redisUrl: platform.ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  app = await createHttpApp('api', {
    config: platform.loadConfig({
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
    logger: platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: platform.loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  });
  await app.init();
  expect(quoters).toHaveBeenCalledTimes(1);
  await db
    .insertInto('config_items')
    .values([
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-viewer',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-viewer',
      },
      {
        app_id: appId,
        key: quoters.mock.calls[0]![0].ruleConfigKey,
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: 'synthetic-viewer',
      },
    ])
    .execute();
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

async function registerDevice(): Promise<Device> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: Device }>().data;
}

async function session(device: Device) {
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
  return { user, device, token: issued.access_token };
}

/** A really signed parse of the signing device; answers the links row of the card it gave. */
async function parse(device: Device, token?: string, extra: Record<string, string> = {}) {
  const payload = JSON.stringify({ text: parseUrl, scene: 'clipboard' });
  const timestamp = String(Math.floor(deps.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  quotedViewers.length = 0;
  const response = await app!.inject({
    method: 'POST',
    url: PATH,
    payload,
    headers: {
      ...headers,
      ...extra,
      'x-device-id': device.device_id,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign('POST', PATH, Buffer.from(payload), timestamp, nonce, device.install_secret),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  const results = validResponse(response, schemas);
  expect(results).toHaveLength(1);
  expect(results[0]?.card).toMatchObject({ product_key: productKey, link_id: expect.any(String) });
  return await db
    .selectFrom('links')
    .select(['user_id', 'device_id', 'scene', 'entry_source', 'identity_snapshot'])
    .where('app_id', '=', appId)
    .where('link_id', '=', results[0]!.card!['link_id'] as string)
    .executeTakeFirstOrThrow();
}

it('[AC-B1-07c#8] 真实 AppModule：登录 token 解析出卡，links 行与报价都按当前用户，登录与游客交替不串身份', async () => {
  const deviceA = await registerDevice();
  const deviceB = await registerDevice();
  const first = await session(deviceA);
  const second = await session(deviceB);

  // Alternation also catches a singleton provider retaining an earlier request's identity.
  for (const account of [first, undefined, second, first]) {
    const row = await parse(deviceB, account?.token);
    const expected = {
      appId,
      userId: account?.user.id ?? null,
      deviceId: (account?.device ?? deviceB).device_id,
    };
    expect(row).toMatchObject({
      user_id: expected.userId,
      device_id: expected.deviceId,
      scene: 'clipboard',
      entry_source: 'parse',
      identity_snapshot: {
        user_id: expected.userId,
        attr_code: account?.user.attrCode ?? null,
      },
    });
    expect(quotedViewers).toEqual([expected]);
  }
}, 60_000);

it('[AC-B1-07c#9] 真实 AppModule：不带 token 是验证过的设备游客，伪造 x-user-id 不提升身份', async () => {
  const device = await registerDevice();
  const victim = await session(await registerDevice());

  const row = await parse(device, undefined, { 'x-user-id': victim.user.id });

  expect(row).toMatchObject({
    user_id: null,
    device_id: device.device_id,
    identity_snapshot: { user_id: null },
  });
  expect(quotedViewers).toEqual([{ appId, userId: null, deviceId: device.device_id }]);
}, 60_000);
