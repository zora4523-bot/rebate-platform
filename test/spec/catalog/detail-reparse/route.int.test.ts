// B1-05w: the detail through the real AppModule, database and Redis: CatalogModule must hand the
// shared re-parse with its lock to the detail route (GET /v1/products/{product_key}). A key with no
// pool row and only a stale product_refs row used to be answered 30143 with no union call, so every
// case here fails on an assertion before the task. The demo adapter's three calls are spied on; each
// case takes an app of its own. Outages stay last: the online breaker is one per app under test.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ProductDetailData } from '../../../../apps/api/src/modules/catalog/detail.ts';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { DemoUnionAdapter, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { assertSchema } from '../hot-rank/kit.ts';
import {
  TIMEOUT,
  REFRESH_NOW,
  seedRef,
  secondsAgo,
  tenant,
  type Tenant,
} from '../product-pool-read/kit.ts';
import { headers, type HttpApp, type Response } from '../search-route/http-kit.ts';
import { title } from '../section-items/kit.ts';
import { CANONICAL_URL } from './kit.ts';
import { AGED_SEC } from './rows-kit.ts';

const root = new URL('../../../../', import.meta.url);
const clock = new platform.FixedClock(REFRESH_NOW);
const logger = platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
const HOLD_MS = 400;
const getItem = vi.spyOn(DemoUnionAdapter.prototype, 'getItem');
const searchItems = vi.spyOn(DemoUnionAdapter.prototype, 'searchItems');
const resolveLink = vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let ruleConfigKey: string;

/** What a card of the app needs: the demo quote and the union's query PID, as wiring.int.test.ts. */
async function seedUnionAccess(appId: string): Promise<void> {
  const settings = [
    ['search.enabled.taobao', true],
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    ['rebate.taobao.compare_rate_ratio_bp', 5000],
    [ruleConfigKey, { reserve_bp: 0, self_share_bp: 10000 }],
  ] as const;
  for (const [key, value] of settings) {
    await db
      .insertInto('config_items')
      .values({
        app_id: appId,
        key,
        value: sql`${JSON.stringify(value)}::jsonb`,
        updated_by: 'synthetic-b1-05w',
      })
      .execute();
  }
  const account = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-b1-05w',
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
      hjy_ignore_evidence_path: 'https://example.test/reparse-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

/** A tenant holding only a stale product_refs row of `stable`: no pool row, no card. */
async function staleTenant(stable: string, canonicalUrl: string | null = null): Promise<Tenant> {
  const owner = await tenant(db, `b1_05w_${randomUUID().replaceAll('-', '').slice(0, 20)}`);
  await seedUnionAccess(owner.appId);
  const aged = secondsAgo(clock, AGED_SEC);
  await seedRef(db, owner, clock, stable, {
    canonical_url: canonicalUrl,
    raw_fetched_at: aged,
    refreshed_at: aged,
  });
  return owner;
}

function detailOf(owner: Tenant, stable: string): Promise<Response> {
  return app!.inject({
    method: 'GET',
    url: `/v1/products/${encodeURIComponent(`tb:${stable}`)}`,
    headers: { ...headers, 'x-app-id': owner.appId },
  });
}

/** Under a raw ID product_refs does not hold, price − coupon = final. */
function unionAnswer(stable: string): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: `rawNew-${stable}`,
    title: title(stable),
    price_fen: 6000n,
    coupon_fen: 1000n,
    final_price_fen: 5000n,
    commission_rate_bp: 1500n,
    quoted_at: clock.now().toISOString(),
  };
}

function unionFinds(stable: string): void {
  searchItems.mockResolvedValue({ items: [unionAnswer(stable)], nextCursor: null });
  getItem.mockResolvedValue(unionAnswer(stable));
}

function storedRef(owner: Tenant, stable: string) {
  return db
    .selectFrom('product_refs')
    .selectAll()
    .where('app_id', '=', owner.appId)
    .where('product_key', '=', `tb:${stable}`)
    .executeTakeFirstOrThrow();
}

function linksOf(owner: Tenant) {
  return db.selectFrom('links').selectAll().where('app_id', '=', owner.appId).execute();
}

function expectOnlineTitleSearch(owner: Tenant, stable: string): void {
  expect(searchItems).toHaveBeenCalled();
  expect(searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: title(stable) });
  expect(searchItems.mock.calls[0]?.[1]).toMatchObject({ appId: owner.appId, purpose: 'online' });
}

async function expectRefused(response: Response, status: number, code: number): Promise<void> {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ code });
  await assertSchema(response.json(), 'ErrorEnvelope');
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

beforeEach(() => {
  getItem.mockReset().mockRejectedValue(outage());
  searchItems.mockReset().mockRejectedValue(outage());
  resolveLink.mockReset().mockRejectedValue(outage());
});

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
  '[B1-05w#56][BR-PROD-05] 真实详情链路：没有池行、product_refs 过期 → online 按标题重解析，200 符合契约，stale=false，product_refs 和链接记新原串',
  async () => {
    const stable = 'Kreparse11';
    const owner = await staleTenant(stable);
    unionFinds(stable);

    const response = await detailOf(owner, stable);

    expect(response.statusCode).toBe(200);
    await assertSchema(response.json(), 'ProductResponse');
    const card = response.json<{ data: ProductDetailData }>().data;
    expect(card).toMatchObject({
      product_key: `tb:${stable}`,
      final_price_fen: 5000,
      stale: false,
    });
    expectOnlineTitleSearch(owner, stable);
    for (const [ref, ctx] of getItem.mock.calls) {
      expect(ref).toMatchObject({ item_id: `rawNew-${stable}` });
      expect(ctx).toMatchObject({ appId: owner.appId, purpose: 'online' });
    }
    expect(await storedRef(owner, stable)).toMatchObject({ raw_item_id: `rawNew-${stable}` });
    expect((await linksOf(owner)).find((row) => row.link_id === card.link_id)).toMatchObject({
      raw_item_id: `rawNew-${stable}`,
    });
  },
  TIMEOUT,
);

it(
  '[B1-05w#57][BR-PROD-05] 真实详情链路：有 canonical_url 先按链接解析，不搜标题',
  async () => {
    const stable = 'Kreparse12';
    const owner = await staleTenant(stable, CANONICAL_URL);
    unionFinds(stable);
    resolveLink.mockResolvedValue({ item: { platform: 'taobao', item_id: `rawNew-${stable}` } });

    const response = await detailOf(owner, stable);

    expect(response.statusCode).toBe(200);
    expect(resolveLink.mock.calls[0]?.[0]).toBe(CANONICAL_URL);
    expect(resolveLink.mock.calls[0]?.[1]).toMatchObject({ appId: owner.appId, purpose: 'online' });
    expect(searchItems).not.toHaveBeenCalled();
    expect(await storedRef(owner, stable)).toMatchObject({
      raw_item_id: `rawNew-${stable}`,
      canonical_url: CANONICAL_URL,
    });
  },
  TIMEOUT,
);

it.each([
  { label: '第一页没有结果', items: [] },
  { label: '第一页只有别的键', items: [unionAnswer('Kelsewhere')] },
])(
  '[B1-05w#58][BR-PROD-05] 真实详情链路：问过联盟、$label → 422 30143，不出卡，product_refs 不动',
  async ({ items }) => {
    const stable = 'Kreparse13';
    const owner = await staleTenant(stable);
    const before = await storedRef(owner, stable);
    searchItems.mockResolvedValue({ items, nextCursor: null });

    const response = await detailOf(owner, stable);

    await expectRefused(response, 422, 30143);
    expectOnlineTitleSearch(owner, stable);
    expect(getItem).not.toHaveBeenCalled();
    expect(await linksOf(owner)).toEqual([]);
    expect(await storedRef(owner, stable)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[B1-05w#59][BR-PROD-05] 真实详情链路：标题搜索 adapter_unimplemented → 422 30143，问过联盟',
  async () => {
    const stable = 'Kreparse14';
    const owner = await staleTenant(stable);
    searchItems.mockRejectedValue(
      new UnionError('adapter_unimplemented', 'synthetic: no title search', 'taobao'),
    );

    const response = await detailOf(owner, stable);

    await expectRefused(response, 422, 30143);
    expectOnlineTitleSearch(owner, stable);
    expect(getItem).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[B1-05w#60][BR-PROD-05] 真实详情链路：解析到新原串、getItem 答下架 → 422 30141',
  async () => {
    const stable = 'Kreparse15';
    const owner = await staleTenant(stable);
    searchItems.mockResolvedValue({ items: [unionAnswer(stable)], nextCursor: null });
    getItem.mockRejectedValue(new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'));

    const response = await detailOf(owner, stable);

    await expectRefused(response, 422, 30141);
    expect(await linksOf(owner)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[B1-05w#61][BR-PROD-05] 真实详情链路：同 App 同 key 并发两个请求经 Redis 锁只发一次标题搜索，都出卡',
  async () => {
    const stable = 'Kreparse16';
    const owner = await staleTenant(stable);
    unionFinds(stable);
    searchItems.mockImplementation(async () => {
      await delay(HOLD_MS);
      return { items: [unionAnswer(stable)], nextCursor: null };
    });

    const responses = await Promise.all([detailOf(owner, stable), detailOf(owner, stable)]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(searchItems).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[B1-05w#62][BR-PROD-05] 真实详情链路：跨 App：两个 App 同 key 并发，锁不跨 App，各用自己的 app_id 搜一次，各写各的行',
  async () => {
    const stable = 'Kreparse17';
    const [first, second] = [await staleTenant(stable), await staleTenant(stable)];
    unionFinds(stable);
    searchItems.mockImplementation(async () => {
      await delay(HOLD_MS);
      return { items: [unionAnswer(stable)], nextCursor: null };
    });

    const responses = await Promise.all([detailOf(first, stable), detailOf(second, stable)]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const askedBy = searchItems.mock.calls.map(([, ctx]) => ctx.appId).sort();
    expect(askedBy).toEqual([first.appId, second.appId].sort());
    expect(await storedRef(first, stable)).toMatchObject({ raw_item_id: `rawNew-${stable}` });
    expect(await storedRef(second, stable)).toMatchObject({ raw_item_id: `rawNew-${stable}` });
  },
  TIMEOUT,
);

it(
  '[B1-05w#63][BR-PROD-05][BR-PRICE-11] 真实详情链路：标题搜索时联盟答不了、没有旧缓存也没有池行 → 504 50401，不是 30143，product_refs 不动，不出卡',
  async () => {
    const stable = 'Kreparse18';
    const owner = await staleTenant(stable);
    const before = await storedRef(owner, stable);

    const response = await detailOf(owner, stable);

    await expectRefused(response, 504, 50401);
    expectOnlineTitleSearch(owner, stable);
    expect(getItem).not.toHaveBeenCalled();
    expect(await linksOf(owner)).toEqual([]);
    expect(await storedRef(owner, stable)).toEqual(before);
  },
  TIMEOUT,
);
