import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogModule,
  CatalogConfigReader,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CATALOG } from '../../../../apps/api/src/modules/catalog/catalog.module.ts';
import { REDIS } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { fixture as searchFixture } from '../search/kit.ts';
import { fixture as detailFixture, item, PRODUCT_KEY } from '../detail/kit.ts';
import { assertContract, createApp, headers } from '../search-route/http-kit.ts';
import { cacheConfig, memoryRedis } from './kit.ts';

const originalModule = CatalogModule.forRoot;
afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05g#24] 真实 AppModule 两个 HTTP 请求共享 Redis 搜索与详情缓存，响应仍过契约', async () => {
  const f = detailFixture();
  const s = searchFixture();
  const memory = memoryRedis();
  const settings = cacheConfig();
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async () => ({
    items: [item()],
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
        { provide: REDIS, useValue: { namespace: () => memory.redis } },
        { provide: GovernedUnion, useValue: { adapter: () => adapter } },
        { provide: LinkRegistrar, useValue: { register: f.register } },
        { provide: RebateQuoter, useValue: { quote: f.quote } },
        { provide: SourceLinkReader, useValue: { entrySource: f.entrySource } },
      ],
    };
  });
  const app = await createApp(f.clock);
  try {
    await app.init();
    const url = '/v1/products/search?platform=taobao&q=synthetic&limit=1';
    const first = await app.inject({ method: 'GET', url, headers });
    const second = await app.inject({ method: 'GET', url, headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await assertContract(first, true);
    await assertContract(second, true);
    expect(searchItems).toHaveBeenCalledTimes(1);
    const body = first.json<{ data: { items: { item_ref: string }[] } }>();
    const ref = body.data.items[0]?.item_ref;
    expect(ref).toEqual(expect.any(String));
    const detailUrl = `/v1/products/${encodeURIComponent(PRODUCT_KEY)}?item_ref=${encodeURIComponent(ref!)}`;
    const detailA = await app.inject({ method: 'GET', url: detailUrl, headers });
    const detailB = await app.inject({ method: 'GET', url: detailUrl, headers });
    expect(detailA.statusCode).toBe(200);
    expect(detailB.statusCode).toBe(200);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(4);
  } finally {
    await app.close();
  }
});
