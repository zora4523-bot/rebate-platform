import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { CallerContext, LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
import type { LandingLink } from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  tokenPrincipal,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  DEVICE,
  MISSING,
  NOW,
  OTHER,
  OTHER_APP,
  OWNER,
  QUOTED,
  ROOT,
  TRACE,
  expectPrivateFieldsAbsent,
  landingData,
  persisted,
  validate,
} from './kit.ts';

interface Response {
  statusCode: number;
  json(): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(key: symbol): T;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

const clock = new FixedClock(NOW);
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
const originalLinking = LinkingModule.forRoot;
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  for (const [id, suffix] of [
    [OWNER, '1'],
    [OTHER, '2'],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id,
        app_id: APP,
        nickname: '合成落地页用户',
        avatar: 'https://example.test/avatar',
        invite_code: `landing${suffix}`,
        attr_code: `demo000${suffix}`,
        level: 'T1',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  await db
    .insertInto('devices')
    .values({
      id: DEVICE,
      app_id: APP,
      device_hash: createHash('sha256').update('synthetic-landing-device').digest('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  // Real search registers the source fixture; observations begin only after this setup.
  await db
    .updateTable('platforms')
    .set({
      search_support: 'supported',
      key_stability: 'stable_24h',
      updated_at: clock.now(),
    })
    .where('code', '=', 'jd')
    .execute();
  const account = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: APP,
      platform: 'jd',
      account_name: 'synthetic-landing-account',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  for (const pidScene of ['query', 'self_buy', 'share'] as const) {
    await db
      .insertInto('union_pids')
      .values({
        id: randomUUID(),
        app_id: APP,
        platform: 'jd',
        union_account_id: account,
        pid: `synthetic-${pidScene}`,
        pid_scene: pidScene,
        status: 'active',
        hjy_ignore_confirmed_at: clock.now(),
        hjy_ignore_evidence_path: 'https://example.test/evidence',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  for (const [key, value] of [
    ['search.enabled.jd', true],
    ['convert.enabled.jd', true],
    ['attr.click_code.jd', false],
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    ['rebate.jd.compare_rate_ratio_bp', 5000],
  ] as const) {
    await db
      .insertInto('config_items')
      .values({
        app_id: APP,
        key,
        value,
        updated_by: 'synthetic-landing-fixture',
      })
      .execute();
  }
}, 180_000);

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    try {
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
});

async function start(withIdentity: boolean) {
  if (withIdentity) {
    // Only the missing CallerContext wiring is replaced. It reads the REAL verified principal;
    // signature/token checks, sessions, landing, catalog, adapters and repositories stay real.
    vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
      const module = originalLinking(...args);
      return {
        ...module,
        providers: (module.providers ?? []).map((provider) => {
          if (
            typeof provider !== 'object' ||
            provider.provide !== CallerContext ||
            !('useFactory' in provider)
          )
            return provider;
          return {
            ...provider,
            useFactory: (request: { headers: Record<string, string> }) => ({
              current: async () => ({
                appId: request.headers['x-app-id']!,
                userId: tokenPrincipal(request)?.uid ?? null,
                deviceId: tokenPrincipal(request)?.device_id ?? null,
              }),
            }),
          };
        }),
      };
    });
  }
  const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
  const quoter = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  expect(quoter).toHaveBeenCalledTimes(1);
  await db
    .insertInto('config_items')
    .values({
      app_id: APP,
      key: quoter.mock.calls[0]![0].ruleConfigKey,
      value: { reserve_bp: 0, self_share_bp: 10000 },
      updated_by: 'synthetic-landing-fixture',
    })
    .onConflict((conflict) => conflict.columns(['app_id', 'key']).doNothing())
    .execute();
  const headers = {
    'x-app-id': APP,
    'x-device-id': DEVICE,
    'x-trace-id': TRACE,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
  };
  const auth = async (userId: string): Promise<Record<string, string>> => {
    const sid = randomUUID();
    await db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        app_id: APP,
        sid,
        user_id: userId,
        device_id: DEVICE,
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    const issued = await app!.get<TokenService>(TOKEN_SERVICE).issueAccess({
      uid: userId,
      app_id: APP,
      sid,
      device_id: DEVICE,
      scp: 'full',
    });
    return { authorization: `Bearer ${issued}` };
  };
  const get = (linkId: string, extra: Record<string, string> = {}) =>
    app!.inject({
      method: 'GET',
      url: `/v1/links/${linkId}`,
      headers: { ...headers, ...extra },
    });
  return { headers, get, auth, convert };
}

async function source(headers: Record<string, string>): Promise<LandingLink> {
  const result = await app!.inject({
    method: 'GET',
    url: '/v1/products/search?platform=jd&q=%E6%BC%94%E7%A4%BA%E5%95%86%E5%93%81&limit=1',
    headers,
  });
  expect(result.statusCode).toBe(200);
  const body = result.json() as { code: number; data: { items: { link_id: string }[] } };
  expect(body.code).toBe(0);
  expect(body.data.items).toHaveLength(1);
  return db
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', body.data.items[0]!.link_id)
    .executeTakeFirstOrThrow();
}

async function clone(original: LandingLink, changes: Partial<LandingLink>): Promise<LandingLink> {
  const row = { ...original, link_id: randomUUID(), ...changes };
  await db.insertInto('links').values(row).execute();
  return row;
}

it('[AC-B1-06j#5] 真实默认装配允许游客查看分享与非分享链接：不登记、不写日志、不转链', async () => {
  const f = await start(false);
  const original = await source(f.headers);
  const shared = await clone(original, {
    user_id: OWNER,
    scene: 'share',
    pid_scene: 'share',
    identity_snapshot: { user_id: OWNER, platform: 'jd', pid_scene: 'share' },
  });
  const before = await persisted(db);
  f.convert.mockClear();
  for (const [row, kind, extra] of [
    [original, 'other', {}],
    [shared, 'share', {}],
  ] as const) {
    const response = await f.get(row.link_id, extra);
    expect(response.statusCode).toBe(200);
    await validate(response.json(), 'LinkLandingResponse');
    expect(landingData(response.json())).toMatchObject({
      link_kind: kind,
      viewer_is_sharer: false,
      product_card: { link_id: row.link_id },
    });
  }
  expect(await persisted(db)).toEqual(before);
  expect(f.convert).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-06j#6] 真实令牌经过身份端口：只对分享者本人显示提示，连续查看不登记、不写日志、不转链', async () => {
  const f = await start(true);
  const original = await source(f.headers);
  const shared = await clone(original, {
    user_id: OWNER,
    scene: 'share',
    pid_scene: 'share',
    identity_snapshot: { user_id: OWNER, platform: 'jd', pid_scene: 'share' },
    quoted_at: new Date(QUOTED),
    expire_at: new Date('2026-10-07T04:00:00.000Z'),
  });
  const self = await clone(original, {
    user_id: OWNER,
    scene: 'detail',
    pid_scene: 'self_buy',
    identity_snapshot: { user_id: OWNER, platform: 'jd', pid_scene: 'self_buy' },
  });
  const ownerAuth = await f.auth(OWNER);
  const otherAuth = await f.auth(OTHER);
  const before = await persisted(db);
  f.convert.mockClear();
  for (const [row, extra, isSharer, kind] of [
    [shared, ownerAuth, true, 'share'],
    [shared, ownerAuth, true, 'share'],
    [shared, {}, false, 'share'],
    [shared, otherAuth, false, 'share'],
    [self, ownerAuth, false, 'other'],
    [self, otherAuth, false, 'other'],
    [original, ownerAuth, false, 'other'],
  ] as const) {
    const response = await f.get(row.link_id, extra);
    expect(response.statusCode).toBe(200);
    await validate(response.json(), 'LinkLandingResponse');
    const data = landingData(response.json());
    expect(data).toMatchObject({
      link_kind: kind,
      viewer_is_sharer: isSharer,
      quoted_at: row.quoted_at!.toISOString(),
      product_card: { link_id: row.link_id, product_key: row.product_key, platform: 'jd' },
    });
    expectPrivateFieldsAbsent(data.product_card);
    expect(await persisted(db)).toEqual(before);
    expect(f.convert).not.toHaveBeenCalled();
  }
}, 60_000);

it('[AC-B1-06j#7] 真实路由对不存在和其他 App 链接返回相同 30144 响应，不泄露存在性', async () => {
  const f = await start(false);
  const original = await source(f.headers);
  const foreign = await clone(original, { app_id: OTHER_APP, user_id: null, device_id: null });
  const before = await persisted(db);
  f.convert.mockClear();
  const missing = await f.get(MISSING);
  const hidden = await f.get(foreign.link_id);
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({ code: 30144, trace_id: TRACE });
  expect(hidden.statusCode).toBe(missing.statusCode);
  expect(hidden.json()).toEqual(missing.json());
  await validate(missing.json(), 'ErrorEnvelope');
  expect(await persisted(db)).toEqual(before);
  expect(f.convert).not.toHaveBeenCalled();
}, 60_000);
