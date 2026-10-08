import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
import * as processCipher from '../../../../apps/api/src/modules/catalog/infra/process-item-ref-cipher.ts';
import {
  LINK_OPEN_PORTS,
  type LinkOpenPorts,
} from '../../../../apps/api/src/modules/linking/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { DEVICE_SIGNING_KEYS, RiskModule } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  DemoUnionAdapter,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';

const root = new URL('../../../../', import.meta.url);
const originalRisk = RiskModule.forRoot;
const originalPlatform = platform.PlatformModule.forRoot;
const clock = new platform.FixedClock('2026-10-08T04:00:00.000Z');
const logger = platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
const productKey = 'tb:synthetic001';
const searchRaw = 'synthetic-search-synthetic001';
const parseRaw = 'synthetic-parse-synthetic001';
const openRaw = 'synthetic-open-synthetic001';
const parseUrl = 'https://tb.example.test/item/synthetic001';
const installSecret = Buffer.from('synthetic-device-signing-material', 'ascii').toString('hex');

interface Response {
  statusCode: number;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}
interface Card {
  product_key: string;
  item_ref: string;
  link_id: string;
}
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;
let schemas: Record<string, JsonSchema>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas = (await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root))))
    .components.schemas;
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

function item(raw: string): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: raw,
    title: '合成密钥互通商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: clock.now().toISOString(),
    coupon_ids: 'synthetic-coupon',
  };
}

function contract(response: Response, name: string): void {
  expect(response.statusCode).toBe(200);
  expect(schemas[name]).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schemas[name]!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
  expect(response.json()).toMatchObject({ code: 0 });
}

async function start(appEnv: 'local' | 'test', fieldCrypto?: platform.FieldCrypto) {
  const appId = `synthetic_key_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const deviceId = randomUUID();
  // Only the device-key storage port is synthetic: real signature, nonce and token checks run.
  // A process without FIELD_CRYPTO cannot decrypt a persisted device signing secret.
  vi.spyOn(RiskModule, 'forRoot').mockImplementation((options) => {
    const module = originalRisk(options);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        {
          provide: DEVICE_SIGNING_KEYS,
          useValue: {
            findActive: async (id: string) =>
              id === deviceId ? { deviceId, appId, installSecret } : null,
          },
        },
      ],
    };
  });
  if (fieldCrypto !== undefined) {
    // Inject a real in-memory field keyring, avoiding any files with key material.
    vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
      const module = originalPlatform(options);
      return {
        ...module,
        providers: [
          ...(module.providers ?? []),
          { provide: platform.FIELD_CRYPTO, useValue: fieldCrypto },
        ],
        exports: [...(module.exports ?? []), platform.FIELD_CRYPTO],
      };
    });
  }
  // Synthetic union DTOs, with distinct raw strings for the same derived product key.
  // Controllers, use cases, card assembly, item_ref providers and persistence stay real.
  vi.spyOn(DemoUnionAdapter.prototype, 'searchItems').mockResolvedValue({
    items: [item(searchRaw)],
    nextCursor: null,
  });
  const getItem = vi
    .spyOn(DemoUnionAdapter.prototype, 'getItem')
    .mockImplementation(async (ref) => item(ref.item_id ?? 'synthetic-missing'));
  vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink').mockResolvedValue({
    item: { platform: 'taobao', item_id: parseRaw },
  });
  vi.spyOn(platform, 'getLinkPatterns').mockReturnValue({
    version: 'synthetic-item-ref-key',
    rules: [
      {
        platform: 'taobao',
        category: 'product',
        hosts: ['tb.example.test'],
        path_patterns: ['/item/*'],
      },
    ],
  });
  const quotes = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: platform.AppConfig;
        clock: platform.FixedClock;
        logger: typeof logger;
        dbHandles: platform.DbHandles;
        redisUrl: platform.ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const config = platform.loadConfig({ APP_ENV: appEnv });
  expect(config.keyring).toBeNull();
  const connection = platform.loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config,
    clock,
    logger,
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  expect(quotes).toHaveBeenCalledTimes(1);
  await db!
    .insertInto('config_items')
    .values([
      { app_id: appId, key: 'search.enabled.taobao', value: true, updated_by: 'synthetic-key' },
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-key',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-key',
      },
      {
        app_id: appId,
        key: quotes.mock.calls[0]![0].ruleConfigKey,
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: 'synthetic-key',
      },
    ])
    .execute();
  await db!
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      device_hash: createHash('sha256').update(deviceId).digest('hex'),
      id_source: 'idfv',
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: clock.now(),
      install_secret_cipher: Buffer.from('synthetic-cipher', 'ascii'),
    })
    .execute();
  const accountId = randomUUID();
  await db!
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-key',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db!
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-site',
      pid: 'synthetic-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-device-id': deviceId,
    'x-trace-id': randomUUID(),
  };
  async function search(): Promise<Card> {
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/products/search?platform=taobao&q=synthetic&limit=1',
      headers,
    });
    contract(response, 'SearchProductsResponse');
    const body = response.json<{ data: { items: Card[] } }>();
    expect(body.data.items).toHaveLength(1);
    return body.data.items[0]!;
  }
  async function parse(): Promise<Card> {
    const path = '/v1/inputs/parse';
    const payload = JSON.stringify({ text: parseUrl, scene: 'clipboard' });
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    const nonce = randomUUID().replace(/-/g, '');
    const signature = createHmac('sha256', installSecret)
      .update(
        ['POST', path, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
          '\n',
        ),
      )
      .digest('hex');
    const response = await app!.inject({
      method: 'POST',
      url: path,
      payload,
      headers: { ...headers, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-sign': signature },
    });
    contract(response, 'ParseInputResponse');
    const body = response.json<{ data: { results: { card?: Card }[] } }>();
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0]?.card).toMatchObject({
      product_key: productKey,
      item_ref: expect.any(String),
    });
    return body.data.results[0]!.card!;
  }
  async function detail(itemRef: string, expectedRaw: string): Promise<Card> {
    getItem.mockClear();
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/products/${encodeURIComponent(productKey)}?${new URLSearchParams({ item_ref: itemRef })}`,
      headers,
    });
    // Assert the response as a value: an old-key rejection must fail an assertion.
    contract(response, 'ProductResponse');
    const card = response.json<{ data: Card }>().data;
    expect(card).toMatchObject({ product_key: productKey, item_ref: itemRef });
    expect(getItem).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ platform: 'taobao', item_id: expectedRaw }),
      expect.any(Object),
    );
    return card;
  }
  function openRef(): string {
    // The real public DI port AppModule supplies to open's card re-check; never a test cipher.
    return app!.get<LinkOpenPorts>(LINK_OPEN_PORTS).itemRefs.issue({
      appId,
      platform: 'taobao',
      productKey,
      rawItemId: openRaw,
      fetchedAt: clock.now().toISOString(),
    });
  }
  return { appId, search, parse, detail, openRef };
}

it.each(['local', 'test'] as const)(
  '[AC-B1-05k#5] %s 真实 AppModule 搜索卡与 open 复核签发器的引用都被详情采用',
  async (appEnv) => {
    const f = await start(appEnv);
    const searched = await f.search();
    await f.detail(searched.item_ref, searchRaw);
    // A different raw string makes product_key fallback distinguishable from the clicked ref.
    const opened = f.openRef();
    await f.detail(opened, openRaw);
    const shared = catalog.createItemRefService({ crypto: catalog.processItemRefCipher() });
    for (const [ref, raw] of [
      [searched.item_ref, searchRaw],
      [opened, openRaw],
    ] as const) {
      expect(shared.verify({ appId: f.appId, productKey, itemRef: ref })).toMatchObject({
        rawItemId: raw,
        source: 'item_ref',
      });
    }
  },
  60_000,
);

it.each(['local', 'test'] as const)(
  '[AC-B1-05k#6] %s 真实解析接口签发的引用可在详情验过并原样透传',
  async (appEnv) => {
    const f = await start(appEnv);
    const parsed = await f.parse();
    await f.detail(parsed.item_ref, parseRaw);
    const shared = catalog.createItemRefService({ crypto: catalog.processItemRefCipher() });
    expect(shared.verify({ appId: f.appId, productKey, itemRef: parsed.item_ref })).toMatchObject({
      rawItemId: parseRaw,
      source: 'item_ref',
    });
  },
  60_000,
);

it('[AC-B1-05k#7] FIELD_CRYPTO 优先于临时提供者，两种密钥互相隔离', async () => {
  const provider = new LocalKeyProvider(Buffer.from('synthetic-master'.padEnd(32, '.'), 'ascii'));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const temporary = vi.spyOn(processCipher, 'processItemRefCipher').mockImplementation(() => {
    throw new Error('unexpected temporary item_ref key');
  });
  const f = await start('test', crypto);
  const verifier = catalog.createItemRefService({ crypto });
  const searched = await f.search();
  const parsed = await f.parse();
  const opened = f.openRef();
  for (const [ref, raw] of [
    [searched.item_ref, searchRaw],
    [parsed.item_ref, parseRaw],
    [opened, openRaw],
  ] as const) {
    expect(verifier.verify({ appId: f.appId, productKey, itemRef: ref })).toMatchObject({
      appId: f.appId,
      productKey,
      rawItemId: raw,
      source: 'item_ref',
    });
    const detailed = await f.detail(ref, raw);
    expect(
      verifier.verify({ appId: f.appId, productKey, itemRef: detailed.item_ref })?.rawItemId,
    ).toBe(raw);
  }
  expect(temporary).not.toHaveBeenCalled();
  temporary.mockRestore();
  const local = catalog.createItemRefService({ crypto: catalog.processItemRefCipher() });
  const localRef = local.issue({
    appId: f.appId,
    platform: 'taobao',
    productKey,
    rawItemId: openRaw,
    fetchedAt: clock.now().toISOString(),
  });
  expect(verifier.verify({ appId: f.appId, productKey, itemRef: localRef })).toBeNull();
  expect(local.verify({ appId: f.appId, productKey, itemRef: opened })).toBeNull();
}, 60_000);
