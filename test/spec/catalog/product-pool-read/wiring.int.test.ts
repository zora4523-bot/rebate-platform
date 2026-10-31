// B1-05r: the read paths through the real AppModule, database and Redis: CatalogModule must hand the
// pool reader to the section and detail use cases, and search must not read the pool (BR-PROD-07).
// A published page, config_items and pool rows are seeded directly; the demo adapter's channel, detail
// and search ports fail as a union outage does. Every case takes an app of its own.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { PageSectionItemsData } from '../../../../apps/api/src/modules/catalog/section-items.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { channel, TB_CHANNEL } from '../hot-rank-upstream/kit.ts';
import { assertSchema } from '../hot-rank/kit.ts';
import { headers, type HttpApp, type Response } from '../search-route/http-kit.ts';
import { title } from '../section-items/kit.ts';
import {
  AD_LABEL,
  FALLBACK_KEY,
  REFRESH_NOW,
  TIMEOUT,
  seedItem,
  seedPool,
  tenant,
  uniqueApp,
  type Tenant,
} from './kit.ts';

const root = new URL('../../../../', import.meta.url);
const PAGE_KEY = 'home';
const SECTION_ID = 'synthetic_feed';
const clock = new platform.FixedClock(REFRESH_NOW);
const logger = platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
const channelRanking = vi.spyOn(DemoUnionAdapter.prototype, 'channelRanking');
const getItem = vi.spyOn(DemoUnionAdapter.prototype, 'getItem');
const searchItems = vi.spyOn(DemoUnionAdapter.prototype, 'searchItems');

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let ruleConfigKey: string;
let appId: string;
let owner: Tenant;

async function setConfig(key: string, value: unknown): Promise<void> {
  await db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      updated_by: 'synthetic-b1-05r',
    })
    .execute();
}

/** What search needs to reach the union: its switch, the demo quote and the query PID. */
async function seedUnionAccess(): Promise<void> {
  await setConfig('search.enabled.taobao', true);
  await setConfig('tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 });
  await setConfig('rebate.taobao.compare_rate_ratio_bp', 5000);
  await setConfig(ruleConfigKey, { reserve_bp: 0, self_share_bp: 10000 });
  const account = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-b1-05r',
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
      union_account_id: account,
      site_id: 'synthetic-site',
      pid: 'synthetic-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/pool-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

/** A published home page holding one section with this data source. */
async function publish(dataSource: unknown): Promise<void> {
  const sections = [{ id: SECTION_ID, type: 'product_grid', data_source: dataSource }];
  await db
    .insertInto('page_versions')
    .values({
      app_id: appId,
      page_key: PAGE_KEY,
      version: 1,
      sections: sql`${JSON.stringify(sections)}::jsonb`,
      status: 'published',
      publish_at: clock.now(),
      publisher: owner.adminId,
      created_by_admin_id: owner.adminId,
      created_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('pages')
    .values({
      app_id: appId,
      page_key: PAGE_KEY,
      current_version: 1,
      gray_version: null,
      gray_percent: 0,
      updated_by_admin_id: owner.adminId,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

function get(url: string): Promise<Response> {
  return app!.inject({ method: 'GET', url, headers: { ...headers, 'x-app-id': appId } });
}

function sectionItems(): Promise<Response> {
  return get(`/v1/pages/${PAGE_KEY}/sections/${SECTION_ID}/items`);
}

async function links() {
  return db.selectFrom('links').selectAll().where('app_id', '=', appId).execute();
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic-pool-read',
    channels: [channel('taobao', TB_CHANNEL)],
  });
  const quotes = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof platform.loadConfig>;
        clock: platform.FixedClock;
        logger: typeof logger;
        dbHandles: platform.DbHandles;
        redisUrl: platform.ConnectionConfig['redisUrl'];
      },
    ) => Promise<HttpApp>;
  };
  app = await createHttpApp('api', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: platform.loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  });
  await app.init();
  ruleConfigKey = quotes.mock.calls[0]![0].ruleConfigKey;
}, 180_000);

beforeEach(async () => {
  appId = uniqueApp();
  owner = await tenant(db, appId);
  channelRanking.mockReset().mockRejectedValue(outage());
  getItem.mockReset().mockRejectedValue(outage());
  searchItems.mockReset().mockRejectedValue(outage());
  await seedUnionAccess();
}, TIMEOUT);

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
    }
  }
}, TIMEOUT);

it(
  '[BR-TEXT-17][BR-PRICE-11] 真实 AppModule：product_pool 数据源出卡，符合契约，ad_label「推广」，stale=false，链接落库，每次请求新建',
  async () => {
    const pool = await seedPool(db, owner, clock);
    await seedItem(db, owner, clock, pool, 'tb:Kwired01');
    await publish({ kind: 'product_pool', pool_id: pool, limit: 10 });

    const first = await sectionItems();
    expect(first.statusCode).toBe(200);
    await assertSchema(first.json(), 'PageSectionItemsResponse');
    const { items } = first.json<{ data: PageSectionItemsData }>().data;
    expect(items).toHaveLength(1);
    const card = items[0]!;
    expect(card).toMatchObject({
      product_key: 'tb:Kwired01',
      title: title('Kwired01'),
      ad_label: AD_LABEL,
      stale: false,
      final_price_fen: 8000,
      rebate_basis: 'normal',
    });
    const row = (await links()).find((link) => link.link_id === card.link_id);
    expect(row).toMatchObject({ product_key: 'tb:Kwired01', quoted_final_price_fen: 8000n });

    const second = await sectionItems();
    expect(second.statusCode).toBe(200);
    const again = second.json<{ data: PageSectionItemsData }>().data.items[0];
    expect(again?.link_id).toEqual(expect.any(String));
    expect(again?.link_id).not.toBe(card.link_id);
    expect(channelRanking).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[BR-PROD-07][BR-TEXT-17] 真实 AppModule：信息流第一页频道全挂 → 读 feed.fallback_pool_id 的池，stale=true，「推广」，符合契约',
  async () => {
    const pool = await seedPool(db, owner, clock);
    await seedItem(db, owner, clock, pool, 'tb:Kwired02');
    await setConfig(FALLBACK_KEY, pool);
    await publish({
      kind: 'union_material',
      channels: [{ platform: 'taobao', channel_id: TB_CHANNEL }],
    });

    const response = await sectionItems();

    expect(response.statusCode).toBe(200);
    await assertSchema(response.json(), 'PageSectionItemsResponse');
    const { items } = response.json<{ data: PageSectionItemsData }>().data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      product_key: 'tb:Kwired02',
      ad_label: AD_LABEL,
      stale: true,
    });
    expect(channelRanking).toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[TRADE-12][BR-PROD-07] 真实 AppModule：联盟故障时详情用池价且 stale=true，同一时刻搜索仍是 50304，不拿商品池冒充搜索结果',
  async () => {
    const key = 'tb:Kwired03';
    const pool = await seedPool(db, owner, clock);
    await seedItem(db, owner, clock, pool, key);
    await db
      .insertInto('product_refs')
      .values({
        app_id: appId,
        product_key: key,
        platform: 'taobao',
        raw_item_id: 'rawRef-Kwired03',
        raw_fetched_at: clock.now(),
        title: title('Kwired03'),
        source: 'search',
        refreshed_at: clock.now(),
      })
      .execute();

    const detail = await get(`/v1/products/${encodeURIComponent(key)}`);

    expect(detail.statusCode).toBe(200);
    await assertSchema(detail.json(), 'ProductResponse');
    expect(detail.json<{ data: unknown }>().data).toMatchObject({
      product_key: key,
      final_price_fen: 8000,
      stale: true,
    });
    expect(getItem).toHaveBeenCalled();

    const query = new URLSearchParams({ platform: 'taobao', q: title('Kwired03') });
    const search = await get(`/v1/products/search?${query}`);

    expect(search.json()).toMatchObject({ code: 50304 });
    expect(JSON.stringify(search.json())).not.toContain(key);
    expect(searchItems).toHaveBeenCalled();
  },
  TIMEOUT,
);
