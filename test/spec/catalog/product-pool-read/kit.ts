// B1-05r rule-test kit (BR-PRICE-11, BR-TEXT-17, BR-PROD-05, BR-PROD-07, TRADE-12; contract
// listPageSectionItems「Union fall-back」「Fetching product_pool」). Real pieces: PostgreSQL as couli_app
// (the int tests hand in createTestDatabase), pg-boss on the test database, the single card entry and
// the reader over the real tables. The union side is a fake of catalog's seams with synthetic data
// only, and no platform payload is imitated.
//
// Every fixture builds the reader or the refresh handler first, so on the skeleton every case stops
// at NotImplemented, the negative ones included. The cases never call the reader's methods and never
// read a job's name or payload: the data source, the cursor, the fan-out and the store behind them
// are the implementer's. Times are written relative to the fixture's clock. The section fixture's
// app is the hot list kit's fixed APP, so its cases stay apart by pool id; detail and refresh cases
// take an app of their own. Rows go in directly: catalog's write path is tested in pool-write.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { createCatalog } from '../../../../apps/api/src/modules/catalog/application/catalog.ts';
import {
  getProduct,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { createKyselyPoolReader } from '../../../../apps/api/src/modules/catalog/infra/kysely-pool-reader.ts';
import type {
  CatalogConfigReader,
  GovernedUnion,
} from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  getSectionItems,
  type PageSectionItemsData,
  type SectionItemsOptions,
  type SectionItemsQuery,
} from '../../../../apps/api/src/modules/catalog/section-items.ts';
import {
  createPoolRefreshJobHandler,
  seedPoolRefresh,
  type PoolRefreshOptions,
} from '../../../../apps/api/src/modules/catalog/worker/pool-refresh.ts';
import {
  FixedClock,
  type Clock,
  type JobHandler,
  type JobPayload,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ItemRef,
  UnionAdapter,
  UnionItem,
  UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { NOW as RANK_NOW, APP } from '../hot-rank/kit.ts';
import { fixture as detailFixture, PRODUCT_KEY } from '../detail/kit.ts';
import { admin } from '../product-pool-schema/kit.ts';
import {
  PAGE_KEY,
  SECTION_ID,
  sectionFixture,
  title,
  type SectionSetup,
} from '../section-items/kit.ts';
import {
  memoryLogger,
  withDatabase,
  withRealQueue,
  type FakeQueue,
} from '../../settlement/worker/kit.ts';

export const TIMEOUT = 120_000;
export const AD_LABEL = '推广';
export const MAX_AGE_KEY = 'pool.max_age_sec';
export const REFRESH_KEY = 'pool.refresh_interval_sec';
export const FALLBACK_KEY = 'feed.fallback_pool_id';
/** BR-PRICE-11 defaults: the seed values, read when the keys are absent. */
export const MAX_AGE_SEC = 7200;
export const REFRESH_SEC = 3600;
/** BR-PROD-05 结果分类 ①: the reason shown to the operator. */
export const OFF_SHELF_REASON = '联盟返回下架';
export const QUEUE = 'pool-refresh';
/** Whole hours from the epoch (also whole 100 s): a round cut at slot boundaries starts here. */
export const REFRESH_NOW = '2026-10-06T10:00:00+08:00';
/** BR-PROD-05: step ① of the raw-ID order takes an instant no older than this. */
export const RAW_MAX_AGE_SEC = 1800;
/** A row added this long ago: its raw ID is that old, whatever a later refresh did to quoted_at. */
export const ADDED_SEC = 3 * 86_400;

type PoolInsert = Insertable<DB['product_pools']>;
type ItemInsert = Insertable<DB['pool_items']>;
type RefInsert = Insertable<DB['product_refs']>;
type Settings = Map<string, unknown>;

export interface PoolDatabase {
  db: Kysely<DB>;
}

/** The int test's createTestDatabase: only *.int.test.ts may import it. */
type CreateDatabase = Parameters<typeof withDatabase>[0];

/** One test database per file; the connection belongs to the container runner. */
export function usePoolDatabase(create: CreateDatabase): PoolDatabase {
  const h = {} as PoolDatabase;
  let database: Awaited<ReturnType<CreateDatabase>> | undefined;
  beforeAll(async () => {
    database = await create();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, TIMEOUT);
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      await database?.drop();
    }
  }, TIMEOUT);
  return h;
}

export function uniqueApp(): string {
  return `b1_05r_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** A pool id in the shape adminCreateProductPool stores (UUIDv7, lowercase). */
export function newPoolId(): string {
  return `0199f105-bbbb-7000-8000-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function millisAgo(clock: Pick<Clock, 'now'>, ms: number): Date {
  return new Date(clock.now().getTime() - ms);
}

export function secondsAgo(clock: Pick<Clock, 'now'>, seconds: number): Date {
  return millisAgo(clock, seconds * 1000);
}

/**
 * The instant a pool card hands to its item_ref and link: step ① of BR-PROD-05 must refuse it. The
 * tests pin no value, only that a refresh, which leaves the raw ID alone, does not make it fresh.
 */
export function expectExpiredRaw(clock: Pick<Clock, 'now'>, fetchedAt: string): void {
  expect(clock.now().getTime() - Date.parse(fetchedAt)).toBeGreaterThan(RAW_MAX_AGE_SEC * 1000);
}

/** The app's config as a map: an absent key reads as unset, as content's reader answers. */
export function configOf(settings: Settings): Pick<CatalogConfigReader, 'configValue'> {
  return {
    configValue: (_appId, key) =>
      Promise.resolve(
        settings.has(key)
          ? { value: settings.get(key) as DB['config_items']['value'], version: 1 }
          : null,
      ),
  };
}

export interface Tenant {
  readonly appId: string;
  readonly adminId: string;
}

export async function tenant(db: Kysely<DB>, appId: string = uniqueApp()): Promise<Tenant> {
  return { appId, adminId: await admin(db, appId) };
}

export async function seedPool(
  db: Kysely<DB>,
  owner: Tenant,
  clock: Pick<Clock, 'now'>,
  extra: Partial<PoolInsert> = {},
): Promise<string> {
  const poolId = extra.pool_id ?? newPoolId();
  await db
    .insertInto('product_pools')
    .values({
      app_id: owner.appId,
      pool_id: poolId,
      name: '合成商品池',
      status: 'active',
      created_by: owner.adminId,
      created_at: clock.now(),
      updated_at: clock.now(),
      ...extra,
    })
    .execute();
  return poolId;
}

/** Same shape as the admin kit's seedItem: the pool's price with price − coupon = final. */
export async function seedItem(
  db: Kysely<DB>,
  owner: Tenant,
  clock: Pick<Clock, 'now'>,
  poolId: string,
  key: string,
  extra: Partial<ItemInsert> = {},
): Promise<void> {
  const stable = key.slice(key.indexOf(':') + 1);
  await db
    .insertInto('pool_items')
    .values({
      app_id: owner.appId,
      pool_id: poolId,
      product_key: key,
      platform: 'taobao',
      raw_item_id: `rawPool-${stable}`,
      title: title(stable),
      price_fen: 8800n,
      coupon_fen: 800n,
      final_price_fen: 8000n,
      commission_rate_bp: 2000,
      quoted_at: clock.now(),
      status: 'online',
      sort: 0,
      created_by: owner.adminId,
      created_at: clock.now(),
      updated_at: clock.now(),
      ...extra,
    })
    .execute();
}

/** BR-PROD-05 order, second step: a product_refs row received now, raw ID rawRef-<stable>. */
export async function seedRef(
  db: Kysely<DB>,
  owner: Tenant,
  clock: Pick<Clock, 'now'>,
  stable: string,
  extra: Partial<RefInsert> = {},
): Promise<void> {
  await db
    .insertInto('product_refs')
    .values({
      app_id: owner.appId,
      product_key: `tb:${stable}`,
      platform: 'taobao',
      raw_item_id: `rawRef-${stable}`,
      raw_fetched_at: clock.now(),
      title: title(stable),
      source: 'search',
      refreshed_at: clock.now(),
      ...extra,
    })
    .execute();
}

export async function itemRow(db: Kysely<DB>, appId: string, poolId: string, key: string) {
  return db
    .selectFrom('pool_items')
    .selectAll()
    .where('app_id', '=', appId)
    .where('pool_id', '=', poolId)
    .where('product_key', '=', key)
    .executeTakeFirstOrThrow();
}

/** A set of `count` zero-padded names, so that key order is the numeric order. */
export function ordered(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}${String(index + 1).padStart(2, '0')}`,
  );
}

// ---------------------------------------------------------------------------------------------
// getSectionItems.

/** sectionFixture with a real reader; run() goes through the reader-carrying options. */
export async function sectionCase(h: PoolDatabase, setup: SectionSetup = {}) {
  const base = sectionFixture(setup);
  const clock = new FixedClock(RANK_NOW);
  const settings: Settings = new Map();
  const poolReader = createKyselyPoolReader({
    db: h.db,
    clock,
    config: configOf(settings),
  });
  const options: SectionItemsOptions = { ...base.options, poolReader };
  const owner = await tenant(h.db, APP);
  const run = (query: Partial<SectionItemsQuery> = {}): Promise<PageSectionItemsData> =>
    getSectionItems({ pageKey: PAGE_KEY, sectionId: SECTION_ID, ...query }, options);
  return {
    ...base,
    clock,
    settings,
    owner,
    options,
    run,
    pool: (extra: Partial<PoolInsert> = {}) => seedPool(h.db, owner, clock, extra),
    /** The card title is title(name), so noRebate(name) applies to it. */
    item: (poolId: string, name: string, extra: Partial<ItemInsert> = {}) =>
      seedItem(h.db, owner, clock, poolId, `tb:${name}`, extra),
    /** The section's data source becomes this pool. */
    show(poolId: unknown, limit = 20): void {
      base.setSection({ dataSource: { kind: 'product_pool', pool_id: poolId, limit } });
    },
    /** Every page from the start, as answered. */
    async walk(): Promise<PageSectionItemsData[]> {
      const pages = [await run()];
      let next = pages[0]!.next_cursor;
      while (next !== null) {
        expect(pages.length, 'pages of the list').toBeLessThan(64);
        const page = await run({ cursor: next });
        pages.push(page);
        next = page.next_cursor;
      }
      return pages;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// getProduct.

export async function detailCase(
  h: PoolDatabase,
  extra: Partial<Pick<ProductDetailOptions, 'priceHistory'>> = {},
) {
  const base = detailFixture();
  const settings: Settings = new Map();
  const poolReader = createKyselyPoolReader({
    db: h.db,
    clock: base.clock,
    config: configOf(settings),
  });
  const owner = await tenant(h.db);
  // The detail kit's app is one constant; each case reads under an app of its own.
  base.current.mockResolvedValue({
    appId: owner.appId,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  });
  const options: ProductDetailOptions = { ...base.options, ...extra, poolReader };
  return {
    ...base,
    settings,
    owner,
    pool: (who: Tenant = owner, poolExtra: Partial<PoolInsert> = {}) =>
      seedPool(h.db, who, base.clock, poolExtra),
    item: (poolId: string, itemExtra: Partial<ItemInsert> = {}, who: Tenant = owner) =>
      seedItem(h.db, who, base.clock, poolId, PRODUCT_KEY, itemExtra),
    run(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, ...query }, options);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The refresh. Real queue on the entry that does not work it: nothing runs by itself, and the jobs
// the seed queued go through the handler by hand, the same way each round.

/** A union answer of one raw ID, built when asked, so its quoted_at is the moment of the answer. */
export type UnionAnswer = () => UnionItemDetail | Error;

export function fakeUnion() {
  const answers = new Map<string, UnionAnswer>();
  const asked: string[] = [];
  const contexts: { readonly appId: string; readonly purpose: string }[] = [];
  const answerOf = (raw: string): UnionItemDetail => {
    const answer = answers.get(raw)?.();
    if (answer === undefined) throw new Error(`synthetic union: unexpected raw id ${raw}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const getItem = vi.fn<UnionAdapter['getItem']>(async (ref: ItemRef, ctx) => {
    const raw = ref.item_id ?? ref.itemId ?? ref.goods_sign ?? ref.skuId ?? '';
    asked.push(raw);
    contexts.push({ appId: ctx.appId, purpose: ctx.purpose });
    return answerOf(raw);
  });
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async (_query, ctx) => {
    contexts.push({ appId: ctx.appId, purpose: ctx.purpose });
    const items: UnionItem[] = [];
    for (const answer of answers.values()) {
      const item = answer();
      if (!(item instanceof Error)) items.push(item);
    }
    return { items, nextCursor: null };
  });
  const resolveLink = vi.fn<UnionAdapter['resolveLink']>(async (_raw, ctx) => {
    contexts.push({ appId: ctx.appId, purpose: ctx.purpose });
    throw new Error('synthetic union: no link answer set');
  });
  const adapter = {
    platform: 'taobao',
    getItem,
    searchItems,
    resolveLink,
  } as unknown as UnionAdapter;
  const union: GovernedUnion = { adapter: () => adapter };
  return { union, answers, asked, contexts, getItem, searchItems, resolveLink };
}

export interface QueuedJob {
  readonly id: string;
  readonly name: string;
  readonly payload: JobPayload;
}

export async function queuedJobs(db: Kysely<DB>): Promise<QueuedJob[]> {
  const { rows } = await sql<QueuedJob>`
    SELECT id::text AS id, data ->> 'name' AS name, data -> 'payload' AS payload
    FROM pgboss.job
    WHERE name = ${QUEUE} AND state = 'created'
    ORDER BY created_on, id`.execute(db);
  return rows;
}

/** Runs what is queued, and what the handler queues, as the queue would. */
export async function drainJobs(db: Kysely<DB>, handler: JobHandler): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    const jobs = await queuedJobs(db);
    if (jobs.length === 0) return;
    for (const job of jobs) {
      await sql`UPDATE pgboss.job SET state = 'active', started_on = now()
        WHERE name = ${QUEUE} AND id = ${job.id}::uuid`.execute(db);
      await handler({ ...job, queue: QUEUE, attempt: 1 });
      await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now()
        WHERE name = ${QUEUE} AND id = ${job.id}::uuid`.execute(db);
    }
  }
  expect.fail('pool-refresh: the queue does not drain');
}

export function refreshOptionsOf(
  db: Kysely<DB>,
  queue: FakeQueue,
  union: GovernedUnion,
  clock: Clock,
  settings: Settings,
  dropDetailCache: (appId: string, productKey: string) => Promise<void>,
): PoolRefreshOptions {
  return {
    db,
    clock,
    queue,
    logger: memoryLogger().logger,
    config: configOf(settings),
    catalog: createCatalog({ db, clock, warn: () => undefined }),
    union,
    dropDetailCache,
  };
}

/** One database per case: a round covers every app, so cases cannot share one. */
export async function refreshCase(
  create: CreateDatabase,
  run: (f: Awaited<ReturnType<typeof buildRefresh>>) => Promise<void>,
): Promise<void> {
  await withDatabase(create, async (db) => {
    await withRealQueue(db, async (queue) => {
      await run(await buildRefresh(db, queue));
    });
  });
}

async function buildRefresh(db: Kysely<DB>, queue: FakeQueue) {
  const clock = new FixedClock(REFRESH_NOW);
  const settings: Settings = new Map();
  const fake = fakeUnion();
  const dropped: [string, string][] = [];
  const options = refreshOptionsOf(db, queue, fake.union, clock, settings, (appId, key) => {
    dropped.push([appId, key]);
    return Promise.resolve();
  });
  const handler = createPoolRefreshJobHandler(options);
  const owner = await tenant(db);
  /** A stable id of its own, so that rows, references and answers line up by name. */
  const stableOf = (): string => `K${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  /** A price apart from the seeded row's; quoted_at is the moment of the answer. */
  const answer = (stable: string, extra: Partial<UnionItemDetail> = {}): UnionItemDetail => ({
    platform: 'taobao',
    item_id: `rawRef-${stable}`,
    title: title(stable),
    price_fen: 6000n,
    coupon_fen: 1000n,
    final_price_fen: 5000n,
    commission_rate_bp: 1500n,
    quoted_at: clock.now().toISOString(),
    ...extra,
  });
  return {
    ...fake,
    db,
    queue,
    clock,
    settings,
    dropped,
    options,
    handler,
    owner,
    stableOf,
    answer,
    other: () => tenant(db),
    pool: (who: Tenant = owner, extra: Partial<PoolInsert> = {}) => seedPool(db, who, clock, extra),
    item: (poolId: string, stable: string, extra: Partial<ItemInsert> = {}, who: Tenant = owner) =>
      seedItem(db, who, clock, poolId, `tb:${stable}`, extra),
    ref: (stable: string, who: Tenant = owner, extra: Partial<RefInsert> = {}) =>
      seedRef(db, who, clock, stable, extra),
    /** The union answers this product under its product_refs raw ID until told otherwise. */
    unionAnswers(stable: string, extra: Partial<UnionItemDetail> = {}): void {
      fake.answers.set(`rawRef-${stable}`, () => answer(stable, extra));
    },
    unionFails(stable: string, error: Error): void {
      fake.answers.set(`rawRef-${stable}`, () => error);
    },
    row: (poolId: string, stable: string, who: Tenant = owner) =>
      itemRow(db, who.appId, poolId, `tb:${stable}`),
    drain: () => drainJobs(db, handler),
    /** One tick of the seed and everything it queued. */
    async round(): Promise<void> {
      await seedPoolRefresh(options);
      await drainJobs(db, handler);
    },
  };
}

export type RefreshCase = Awaited<ReturnType<typeof buildRefresh>>;
