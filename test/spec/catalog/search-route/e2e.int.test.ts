import { randomUUID } from 'node:crypto';
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
import * as search from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { assertContract, headers, type HttpApp } from './http-kit.ts';

const root = new URL('../../../../', import.meta.url);
const clock = new FixedClock('2026-10-07T12:00:00+08:00');
// Every run owns its app scope, including keys on a shared test Redis; never flush Redis.
const appId = `synthetic-search-${randomUUID()}`;
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  await db
    .insertInto('config_items')
    .values([
      {
        app_id: appId,
        key: 'search.enabled.taobao',
        value: true,
        updated_by: 'synthetic-search-fixture',
      },
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-search-fixture',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-search-fixture',
      },
    ])
    .execute();
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-search-account',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-query-site',
      pid: 'synthetic-query-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/synthetic-query-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}, 180_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
        vi.restoreAllMocks();
      }
    }
  }
});

async function startApp(): Promise<HttpApp> {
  // Dynamic import follows the HTTP integration-test precedent: Nest/decorator code is
  // compiled by the API project, not the erasable-only rule-test TypeScript project.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ) => Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  return app;
}

it('[AC-B1-05j#19] 真实 AppModule 游客搜索写入报价链接，重建应用后用 Redis 会话游标取得第二页', async () => {
  // Observation only: both spies call their original implementation. No provider, service,
  // adapter, quote, registration or session store is replaced by a fake.
  const quotes = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const searches = vi.spyOn(search, 'searchProducts');
  await startApp();
  expect(quotes).toHaveBeenCalled();
  const quoteOptions = quotes.mock.calls[0]![0];
  expect(quoteOptions).toMatchObject({ appEnv: 'test', unionMode: 'demo' });
  // The existing factory takes an explicit synthetic rule key. Seed the key chosen by real
  // assembly instead of prescribing a new business config key in this wiring test.
  await db!
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: quoteOptions.ruleConfigKey,
      value: { reserve_bp: 0, self_share_bp: 10000 },
      updated_by: 'synthetic-search-fixture',
    })
    .execute();

  const query = new URLSearchParams({ platform: 'taobao', q: '演示商品', limit: '2' });
  const request = () =>
    app!.inject({
      method: 'GET',
      url: `/v1/products/search?${query}`,
      headers: { ...headers, 'x-app-id': appId },
    });
  const first = await request();
  expect(first.statusCode).toBe(200);
  await assertContract(first, true);
  const firstBody = first.json<{ code: number; data: search.SearchProductsData }>();
  expect(firstBody.code).toBe(0);
  expect(firstBody.data.items).toHaveLength(2);
  expect(firstBody.data).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
  expect(searches).toHaveBeenCalledTimes(1);
  // Decode with the production codec observed on the real use-case call; the wire cursor
  // stays opaque and this test does not impose JSON/base64 or another encoding on it.
  const options = searches.mock.calls[0]![1];
  const claims = options.cursors.decode(firstBody.data.next_cursor!);
  expect(claims).toEqual({ search_session_id: expect.any(String), page_no: 2 });

  await app!.close();
  app = undefined;
  await startApp();
  query.set('cursor', firstBody.data.next_cursor!);
  const second = await request();
  expect(second.statusCode).toBe(200);
  await assertContract(second, true);
  const secondBody = second.json<{ code: number; data: search.SearchProductsData }>();
  expect(secondBody.code).toBe(0);
  expect(secondBody.data.items).toHaveLength(2);
  expect(searches).toHaveBeenCalledTimes(2);
  expect(secondBody.data.next_cursor).toEqual(expect.any(String));
  expect(searches.mock.calls[1]![1].cursors.decode(secondBody.data.next_cursor!)).toEqual({
    ...(claims as search.SearchCursor),
    page_no: 3,
  });
  // The shipped demo catalog returns ten upstream items per page. Zero-commission entries
  // 01 and 11 are filtered, so these serials distinguish page 2 from a restarted page 1.
  expect(firstBody.data.items.map((card) => card.title?.slice(-2))).toEqual(['02', '03']);
  expect(secondBody.data.items.map((card) => card.title?.slice(-2))).toEqual(['12', '13']);

  const cards = [...firstBody.data.items, ...secondBody.data.items];
  const ids = cards.map((card) => card.link_id!);
  expect(new Set(ids).size).toBe(4);
  const rows = await db!
    .selectFrom('links')
    .selectAll()
    .where('app_id', '=', appId)
    .where('link_id', 'in', ids)
    .execute();
  expect(rows).toHaveLength(4);
  for (const card of cards) {
    expect(card.rebate_max_fen).toBeGreaterThan(0);
    expect(rows.find((row) => row.link_id === card.link_id)).toMatchObject({
      app_id: appId,
      platform: 'taobao',
      entry_source: 'search',
      user_id: null,
      quoted_final_price_fen: BigInt(card.final_price_fen!),
      quoted_coupon_fen: BigInt(card.coupon_fen!),
      convert_result: null,
    });
  }
}, 60_000);
