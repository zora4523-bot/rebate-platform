// B1-17c (round 2, review r1 S1 on wiring.test.ts): the cap on price_snapshot write transactions
// is one per process, not one per request. Several searches with different keywords that all miss
// the cache at once must together keep at most 2 write transactions in flight (B1-17b followup F:
// the writes must not take the API's pool; BR-WATCH-19 (1) 不得影响接口).
import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogConfigReader,
  CatalogModule,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CATALOG } from '../../../../apps/api/src/modules/catalog/catalog.module.ts';
import { DB, REDIS } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { cacheConfig, memoryRedis } from '../cache/kit.ts';
import { fixture as detailFixture, item } from '../detail/kit.ts';
import { fixture as searchFixture } from '../search/kit.ts';
import { createApp, headers } from '../search-route/http-kit.ts';
import { fakeDb, settle } from './kit.ts';

const originalModule = CatalogModule.forRoot;
afterEach(() => vi.restoreAllMocks());

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

/** A union whose search answers three distinct items per keyword. */
function keywordAdapter() {
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async (query) => ({
    items: ['1', '2', '3'].map((n) =>
      item({ item_id: `synthetic-prefix-${query.keyword}${n}`, title: `合成商品${n}` }),
    ),
    nextCursor: null,
  }));
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems,
    getItem: async () => {
      throw new Error('Unexpected getItem');
    },
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
  return { adapter, searchItems };
}

it('[AC-B1-17c#20] 真实 AppModule：三个不同关键词的搜索同时缓存未命中，写事务合计最多 2 个在途（上限按进程而非按请求），其余随释放补上', async () => {
  const database = fakeDb(true);
  const union = keywordAdapter();
  const f = catalogModuleWith(database.db, union.adapter);
  const app = await createApp(f.clock);
  try {
    await app.init();
    const responses = await Promise.all(
      ['alpha', 'beta', 'gamma'].map((q) =>
        app.inject({
          method: 'GET',
          url: `/v1/products/search?platform=taobao&q=${q}&limit=3`,
          headers,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(union.searchItems).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(database.execute).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await settle(30);
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(database.inFlight()).toBe(2);

    const peaks: number[] = [];
    for (let step = 0; step < 20 && database.execute.mock.calls.length < 9; step += 1) {
      database.releaseOne();
      await settle(10);
      peaks.push(database.inFlight());
    }
    expect(database.execute).toHaveBeenCalledTimes(9);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  } finally {
    database.releaseAll();
    await app.close();
  }
}, 10000);
