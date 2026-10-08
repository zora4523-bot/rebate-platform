// D6-8 (02 §14): with Redis unavailable a first-page search still answers from the union through
// the production wiring (page cache, cursor ledger, CAS session store), without a next cursor.
import { expect, it, vi } from 'vitest';
import { addFen } from '@couli/money';
import { FixedClock, RedisUnavailableError, type RedisNamespace } from '../../platform/index.ts';
import type { UnionAdapter, UnionItem, UnionPidRow } from '../../union/index.ts';
import { createCatalogCardEntry } from '../application/card-entry.ts';
import type { CardQuoteContext } from '../application/card-assembler.ts';
import type { RebateQuote, Viewer } from '../ports.ts';
import {
  searchProducts,
  type SearchCandidate,
  type SearchCursor,
  type SearchProductsOptions,
  type SearchSession,
  type SearchUpstreamRequest,
} from '../search.ts';
import { cacheSearchUpstream } from './product-cache.ts';
import { createRedisSearchSessionStore, createUnionSearchUpstream } from './search-wiring.ts';

const NOW = '2026-10-08T10:00:00+08:00';

async function observed<T>(action: () => Promise<T>) {
  try {
    return { kind: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { kind: 'rejected' as const, error };
  }
}

function fixture() {
  const viewer: Viewer = {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
  };
  const clock = new FixedClock(NOW);
  const current = async () => viewer;
  const pid: UnionPidRow = {
    id: 'synthetic-pid-row',
    app_id: viewer.appId,
    platform: 'taobao',
    union_account_id: 'synthetic-account',
    site_id: null,
    pid: 'synthetic-query-pid',
    pid_scene: 'query',
    status: 'active',
    created_at: clock.now(),
    updated_at: clock.now(),
    row_version: 0,
    hjy_ignore_confirmed_at: clock.now(),
    hjy_ignore_evidence_path: 'synthetic-evidence',
  };
  let registered = 0;
  const register = vi.fn(async () => ({
    linkId: `00000000-0000-7000-8000-${String(++registered).padStart(12, '0')}`,
  }));
  const warn = vi.fn();
  const quote = async (
    _item: UnionItem,
    _viewer: Viewer,
    context?: CardQuoteContext,
  ): Promise<RebateQuote> => ({
    rebateMinFen: 20n,
    rebateMaxFen: 20n,
    estNetPriceFen: null,
    rebateBasis: context?.rebateBasis ?? 'normal',
  });
  const cards = createCatalogCardEntry({
    clock,
    viewerContext: { current },
    quoter: { quote },
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn },
  });
  const payloads = new Map<string, SearchCursor>();
  const cursors = {
    encode: (value: SearchCursor) => {
      const wire = `synthetic-cursor-${payloads.size + 1}`;
      payloads.set(wire, value);
      return wire;
    },
    decode: (wire: string): unknown => payloads.get(wire),
  };
  const options: Omit<SearchProductsOptions, 'config' | 'upstream' | 'sessions'> = {
    clock,
    viewerContext: { current },
    pids: { getActivePid: async () => pid },
    catalog: {
      requirePlatform: async (code: string) => ({
        code,
        key_prefix: 'tb',
        key_stability: 'stable_7d' as const,
        search_support: 'supported',
        convert_support: 'supported',
        order_sync_support: 'supported',
        stage: 'launched',
      }),
      resolveProductKey: async (key: string) => key,
    },
    cards,
    cursors,
    newSessionId: () => 'synthetic-session-1',
    logger: { warn },
  };
  return { clock, register, warn, cursors, options };
}

function downRedis(): RedisNamespace {
  const down = async (): Promise<never> => {
    throw new RedisUnavailableError('connect_failed');
  };
  return { get: vi.fn(down), set: vi.fn(down), eval: vi.fn(down) };
}

function wired() {
  const f = fixture();
  const redis = downRedis();
  const publicItem: UnionItem = {
    platform: 'taobao',
    item_id: 'synthetic-down001',
    title: 'synthetic-down001',
    price_fen: addFen(1000n, 100n),
    coupon_fen: 100n,
    final_price_fen: 1000n,
    commission_rate_bp: 1000n,
    quoted_at: NOW,
  };
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async () => ({
    items: [publicItem],
    nextCursor: 'synthetic-union-next',
  }));
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems,
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
  const config = {
    configValue: async (_appId: string, key: string) =>
      key.startsWith('search.enabled.') ? { value: true, version: 1 } : null,
  };
  const catalog = {
    listPlatforms: async () => [
      {
        code: 'taobao',
        key_prefix: 'tb',
        key_stability: 'stable_7d' as const,
        search_support: 'supported',
        convert_support: 'supported',
        order_sync_support: 'supported',
        stage: 'launched',
      },
    ],
  };
  const upstream = cacheSearchUpstream(
    createUnionSearchUpstream({
      union: { adapter: () => adapter },
      catalog,
      config,
      clock: f.clock,
      ledger: redis,
    }),
    { config, clock: f.clock, redis },
  );
  const options = {
    ...f.options,
    config,
    upstream,
    sessions: createRedisSearchSessionStore(redis),
  };
  return { f, redis, searchItems, options };
}

it('[AC-B1-05g] Redis 不可用：首页搜索照常直读联盟出结果，next_cursor 为 null、has_more 保持联盟报告值', async () => {
  const { f, redis, searchItems, options } = wired();
  const result = await searchProducts(
    { platform: 'taobao', q: 'synthetic milk', limit: 1 },
    options,
  );
  expect(searchItems).toHaveBeenCalledTimes(1);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ stale: false });
  expect(result.next_cursor).toBeNull();
  // has_more is what the union reported (it returned a next cursor), not rewritten by D6-8.
  expect(result.has_more).toBe(true);
  expect(f.register).toHaveBeenCalledTimes(1);
  // The session write was attempted (and failed) instead of being skipped.
  expect(redis.get).toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'search_session_unavailable', op: 'write' }),
    expect.any(String),
  );
});

it('[AC-B1-05g] Redis 不可用：带游标的续页回 50304 { platform }，不是 500', async () => {
  const { f, options } = wired();
  const cursor = f.cursors.encode({ search_session_id: 'synthetic-session-x', page_no: 2 });
  const outcome = await observed(() =>
    searchProducts({ platform: 'taobao', q: 'synthetic milk', limit: 1, cursor }, options),
  );
  expect(outcome).toMatchObject({
    kind: 'rejected',
    error: { code: 50304, data: { platform: 'taobao' } },
  });
});

it('[AC-B1-05g] Redis 的其他错误照旧上抛，不按不可用降级', async () => {
  const { options } = wired();
  const failure = new TypeError('synthetic defect');
  const sessions = {
    read: async () => null,
    write: async () => {
      throw failure;
    },
  };
  const outcome = await observed(() =>
    searchProducts({ platform: 'taobao', q: 'synthetic milk', limit: 1 }, { ...options, sessions }),
  );
  expect(outcome).toMatchObject({ kind: 'rejected', error: failure });
});

it('[AC-B1-05g] 第 100 页：补页不向联盟请求第 101 页，next_cursor 为 null、has_more 保持联盟报告值', async () => {
  const f = fixture();
  const candidate = (name: string): SearchCandidate => ({
    item: {
      platform: 'taobao',
      item_id: name,
      title: name,
      price_fen: 1000n,
      coupon_fen: 0n,
      final_price_fen: 1000n,
      commission_rate_bp: 1000n,
      quoted_at: NOW,
    },
    ref: {
      appId: 'synthetic-app',
      platform: 'taobao',
      productKey: `tb:${name}`,
      rawItemId: name,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: name,
      shopId: null,
      shopType: null,
      source: 'search',
    },
  });
  // Page 1 delivers one card; page 100 comes back empty but the union still says has_more.
  const search = vi.fn(async (input: SearchUpstreamRequest) => ({
    items: input.pageNo === 1 ? [candidate('synthetic-cap001')] : [],
    hasMore: true,
  }));
  const rows = new Map<string, SearchSession>();
  const options: SearchProductsOptions = {
    ...f.options,
    config: {
      configValue: async (_appId: string, key: string) =>
        key.startsWith('search.enabled.') ? { value: true, version: 1 } : null,
    },
    upstream: {
      search,
      materialFeed: async () => ({ items: [], hasMore: false }),
    },
    sessions: {
      read: async (appId, sessionId) => rows.get(`${appId}:${sessionId}`) ?? null,
      write: async (appId, sessionId, session) => {
        rows.set(`${appId}:${sessionId}`, session);
      },
    },
  };
  const query = { platform: 'taobao' as const, q: 'synthetic cap', limit: 1 };
  const first = await searchProducts(query, options);
  expect(first.next_cursor).not.toBeNull();

  search.mockClear();
  const last = await observed(() =>
    searchProducts(
      {
        ...query,
        cursor: f.cursors.encode({ search_session_id: 'synthetic-session-1', page_no: 100 }),
      },
      options,
    ),
  );
  expect(last).toMatchObject({
    kind: 'returned',
    value: { items: [], next_cursor: null, has_more: true },
  });
  expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pageNo: 100 }));
});
