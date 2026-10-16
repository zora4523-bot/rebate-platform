// B1-17c: assembly of the hooks (orchestrator semantics B.6 and B1-17b followup F): the modules
// build one recorder from the DB handle with createPriceHistoryRecorder (B1-17b's recorder behind
// a cap of 2 store writes in flight), and the cache in front of the union decides freshness.
import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogConfigReader,
  CatalogModule,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
  createPriceHistoryRecorder,
  type PriceSnapshotWrite,
  type PriceSnapshotWriteOutcome,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CATALOG } from '../../../../apps/api/src/modules/catalog/catalog.module.ts';
import { DB, FixedClock, REDIS } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { cacheConfig, memoryRedis } from '../cache/kit.ts';
import { PRODUCT_KEY, fixture as detailFixture, item } from '../detail/kit.ts';
import { deferred, observation, type Deferred } from '../price-history/kit.ts';
import { fixture as searchFixture } from '../search/kit.ts';
import { createApp, headers } from '../search-route/http-kit.ts';
import { fakeDb, settle } from './kit.ts';

const originalModule = CatalogModule.forRoot;
afterEach(() => vi.restoreAllMocks());

it('[AC-B1-17c#14] 装配层并发上限：同时在途的 store 写入不超过 2，其余按到达顺序排队，失败也释放名额；跳过与失败计数沿用写入器', async () => {
  const pending: Deferred<PriceSnapshotWriteOutcome>[] = [];
  const write = vi.fn((input: PriceSnapshotWrite) => {
    void input;
    const next = deferred<PriceSnapshotWriteOutcome>();
    pending.push(next);
    return next.promise;
  });
  const warn = vi.fn();
  const recorder = createPriceHistoryRecorder({
    store: { write },
    clock: new FixedClock('2031-03-10T08:00:00.000+08:00'),
    config: { configValue: async () => null },
    logger: { warn },
  });
  for (const key of ['tb:1', 'tb:2', 'tb:3', 'tb:4', 'tb:5']) {
    recorder.record(observation({ productKey: key }));
  }
  // Rejected by the writer's own skip rules: never reaches the store.
  recorder.record(observation({ productKey: 'pdd:6', platform: 'pdd', goodsSignPlan: null }));
  await settle(20);
  expect(write.mock.calls.map(([input]) => input.productKey)).toEqual(['tb:1', 'tb:2']);

  pending[0]!.resolve('inserted');
  await settle(20);
  expect(write.mock.calls.map(([input]) => input.productKey)).toEqual(['tb:1', 'tb:2', 'tb:3']);

  pending[1]!.reject(new Error('synthetic database failure'));
  await settle(20);
  expect(write.mock.calls.map(([input]) => input.productKey)).toEqual([
    'tb:1',
    'tb:2',
    'tb:3',
    'tb:4',
  ]);

  let drained = false;
  const draining = recorder.drain().then(() => {
    drained = true;
  });
  await settle(20);
  expect(drained).toBe(false);
  pending[2]!.resolve('inserted');
  pending[3]!.resolve('touched');
  await settle(20);
  expect(write.mock.calls.map(([input]) => input.productKey)).toEqual([
    'tb:1',
    'tb:2',
    'tb:3',
    'tb:4',
    'tb:5',
  ]);
  pending[4]!.resolve('unchanged');
  await draining;
  expect(drained).toBe(true);
  expect(write).toHaveBeenCalledTimes(5);
  expect(recorder.failureCount()).toBe(1);
  expect(warn).toHaveBeenCalledWith({ code: 'PRICE_SNAPSHOT_WRITE_FAILED' });
}, 5000);

/** CatalogModule as AppModule builds it, with synthetic ports and the given DB stand-in. */
function catalogModuleWith(db: unknown, adapter: UnionAdapter) {
  const f = detailFixture();
  const s = searchFixture();
  const memory = memoryRedis();
  const settings = cacheConfig();
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((config) => {
    const module = originalModule(config);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).map((provider) => {
          if (typeof provider !== 'object') return provider;
          if (provider.provide === CATALOG)
            return { provide: CATALOG, useValue: { ...f.options.catalog, ...s.options.catalog } };
          if (provider.provide === CatalogConfigReader)
            return { provide: CatalogConfigReader, useValue: settings.config };
          if (typeof provider.provide === 'symbol') {
            if (provider.provide.description === 'CATALOG_QUERY_PIDS')
              return { provide: provider.provide, useValue: s.options.pids };
            if (provider.provide.description === 'CATALOG_SEARCH_SESSIONS')
              return { provide: provider.provide, useValue: s.sessions };
          }
          return provider;
        }),
        { provide: DB, useValue: db },
        { provide: REDIS, useValue: { namespace: () => memory.redis } },
        { provide: GovernedUnion, useValue: { adapter: () => adapter } },
        { provide: LinkRegistrar, useValue: { register: f.register } },
        { provide: RebateQuoter, useValue: { quote: f.quote } },
        { provide: SourceLinkReader, useValue: { entrySource: f.entrySource } },
      ],
    };
  });
  return f;
}

function adapterOf(items: readonly UnionItem[]) {
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async () => ({
    items: [...items],
    nextCursor: null,
  }));
  const getItem = vi.fn<UnionAdapter['getItem']>(async () => item());
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems,
    getItem,
    resolveLink: async () => {
      throw new Error('Unexpected resolveLink');
    },
    convert: async () => {
      throw new Error('Unexpected convert');
    },
    listOrders: async () => {
      throw new Error('Unexpected listOrders');
    },
  };
  return { adapter, searchItems, getItem };
}

it('[AC-B1-17c#15] 真实 AppModule：搜索与详情的联盟新鲜返回经模块装配的记录器写库，缓存命中不写，响应不等写库', async () => {
  const database = fakeDb(true);
  const union = adapterOf([item()]);
  const f = catalogModuleWith(database.db, union.adapter);
  const app = await createApp(f.clock);
  try {
    await app.init();
    const url = '/v1/products/search?platform=taobao&q=synthetic&limit=1';
    // The write is held in flight: the response must not wait for it.
    const first = await app.inject({ method: 'GET', url, headers });
    expect(first.statusCode).toBe(200);
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    database.releaseAll();

    const second = await app.inject({ method: 'GET', url, headers });
    expect(second.statusCode).toBe(200);
    expect(union.searchItems).toHaveBeenCalledTimes(1);
    await settle(30);
    expect(database.execute).toHaveBeenCalledTimes(1);

    const body = first.json<{ data: { items: { item_ref: string }[] } }>();
    const ref = body.data.items[0]?.item_ref;
    expect(ref).toEqual(expect.any(String));
    const detailUrl = `/v1/products/${encodeURIComponent(PRODUCT_KEY)}?item_ref=${encodeURIComponent(ref!)}`;
    const detailA = await app.inject({ method: 'GET', url: detailUrl, headers });
    expect(detailA.statusCode).toBe(200);
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    database.releaseAll();
    const detailB = await app.inject({ method: 'GET', url: detailUrl, headers });
    expect(detailB.statusCode).toBe(200);
    expect(union.getItem).toHaveBeenCalledTimes(1);
    await settle(30);
    expect(database.execute).toHaveBeenCalledTimes(2);
  } finally {
    database.releaseAll();
    await app.close();
  }
}, 10000);

it('[AC-B1-17c#16] 真实 AppModule：一页 5 个新鲜候选同时最多 2 个写事务在途，其余随释放补上', async () => {
  const database = fakeDb(true);
  const items = ['1', '2', '3', '4', '5'].map((n) =>
    item({ item_id: `synthetic-prefix-hook${n}`, title: `合成商品${n}` }),
  );
  const union = adapterOf(items);
  const f = catalogModuleWith(database.db, union.adapter);
  const app = await createApp(f.clock);
  try {
    await app.init();
    const url = '/v1/products/search?platform=taobao&q=synthetic&limit=5';
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await settle(30);
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(database.inFlight()).toBe(2);

    database.releaseOne();
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(3), {
      timeout: 2000,
    });
    expect(database.inFlight()).toBe(2);

    await vi.waitFor(
      () => {
        database.releaseAll();
        expect(database.execute).toHaveBeenCalledTimes(5);
      },
      { timeout: 2000 },
    );
  } finally {
    database.releaseAll();
    await app.close();
  }
}, 10000);
