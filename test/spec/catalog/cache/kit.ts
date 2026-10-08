import { vi } from 'vitest';
import {
  cacheDetailUpstream,
  cacheSearchUpstream,
} from '../../../../apps/api/src/modules/catalog/infra/product-cache.ts';
import { createUnionSearchUpstream } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import {
  searchProducts,
  type SearchProductsQuery,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  getProduct,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  RedisUnavailableError,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionAdapter,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { candidate, fixture as searchFixture, observed } from '../search/kit.ts';
import { fixture as detailFixture, item, PRODUCT_KEY, RAW_ID, APP_ID } from '../detail/kit.ts';

export { observed, PRODUCT_KEY, RAW_ID, APP_ID };
export const APP = 'synthetic_cache';

/** Storage only: never expires rows, so logical freshness cannot rely on physical TTL. */
export function memoryRedis() {
  const rows = new Map<string, string>();
  let failure: 'get' | 'set' | null = null;
  const get = vi.fn(async (key: string) => {
    if (failure === 'get') throw new RedisUnavailableError('command_failed');
    return rows.get(key) ?? null;
  });
  const set = vi.fn(async (key: string, value: string, ttlSeconds: number) => {
    void ttlSeconds;
    if (failure === 'set') throw new RedisUnavailableError('command_failed');
    rows.set(key, value);
  });
  const redis: RedisNamespace = {
    get,
    set,
    eval: vi.fn(async () => {
      throw new Error('Unexpected Lua on the page cache');
    }),
  };
  return {
    redis,
    rows,
    get,
    set,
    fail(operation: typeof failure) {
      failure = operation;
    },
  };
}

export function cacheConfig() {
  const values = new Map<string, string | number | boolean>();
  const config: CatalogConfigReader = {
    configValue: vi.fn(async (_appId, key) => {
      if (values.has(key)) return { value: values.get(key)!, version: 1 };
      if (key.startsWith('search.enabled.')) return { value: true, version: 1 };
      return null;
    }),
  };
  return { values, config };
}

export function searchCache(redisState = memoryRedis(), enabled = true) {
  const f = searchFixture();
  f.setViewer({ appId: APP });
  const settings = cacheConfig();
  const publicItem = { ...candidate('cache001', 1000n, 100n).item, item_id: 'synthetic-cache001' };
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async () => ({
    items: [publicItem],
    nextCursor: null,
  }));
  const materialFeed = vi.fn<NonNullable<UnionAdapter['materialFeed']>>(async () => ({
    items: [],
    nextCursor: null,
  }));
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems,
    materialFeed,
    getItem: async () => publicItem,
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
  const union = { adapter: vi.fn(() => adapter) };
  const catalog = {
    listPlatforms: async () =>
      ['taobao', 'jd', 'pdd'].map((code) => ({
        code,
        key_prefix: code === 'taobao' ? 'tb' : code,
        key_stability: 'stable_7d' as const,
        search_support: 'supported',
        convert_support: 'supported',
        order_sync_support: 'supported',
        stage: 'launched',
      })),
  };
  const upstream = cacheSearchUpstream(
    createUnionSearchUpstream({
      union,
      catalog,
      config: settings.config,
      clock: f.clock,
      ledger: null,
    }),
    { config: settings.config, clock: f.clock, redis: enabled ? redisState.redis : null },
  );
  const options = { ...f.options, config: settings.config, upstream };
  return {
    ...f,
    ...settings,
    ...redisState,
    options,
    upstream,
    searchItems,
    materialFeed,
    publicItem,
    run(query: Partial<SearchProductsQuery> = {}) {
      return searchProducts(
        { platform: 'taobao', q: 'synthetic milk', limit: 1, ...query },
        options,
      );
    },
  };
}

export function detailCache(redisState = memoryRedis(), enabled = true) {
  const f = detailFixture();
  const settings = cacheConfig();
  const getItem = vi.fn<UnionAdapter['getItem']>(async () => item());
  const adapter: UnionAdapter = {
    platform: 'taobao',
    getItem,
    searchItems: async () => {
      throw new Error('Unexpected searchItems');
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
  const makeUpstream = () =>
    cacheDetailUpstream(createUnionDetailUpstream({ union: { adapter: () => adapter } }), {
      redis: enabled ? redisState.redis : null,
      clock: f.clock,
      config: settings.config,
    });
  const upstream = makeUpstream();
  const options = { ...f.options, config: settings.config, upstream };
  return {
    ...f,
    ...settings,
    ...redisState,
    getItem,
    upstream,
    makeUpstream,
    options,
    get(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, item_ref: f.issue(), ...query }, options);
    },
  };
}

export const dependencyErrors = () => [
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'),
  new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
];

/** Extra normalized-adapter fields, not a recorded platform payload. */
export function contaminated(value: UnionItem): UnionItem {
  return Object.assign({}, value, {
    coupon_share_url: 'https://example.test/synthetic-coupon',
    click_url: 'https://example.test/synthetic-click',
    url: 'https://example.test/synthetic-url',
    arbitrary_tpwd: 'synthetic-password',
    rebate_min_fen: 321,
    rebate_max_fen: 654,
    est_net_price_fen: 777,
    link_id: 'synthetic-link',
    user_id: 'synthetic-private-user',
    relation_id: 'synthetic-relation',
  });
}
