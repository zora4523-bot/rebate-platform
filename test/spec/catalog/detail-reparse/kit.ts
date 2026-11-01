// B1-05w rule-test kit (BR-PROD-05 重新解析步骤与结果分类, BR-PRICE-11, 编排 12:06 ③ FU-DETAIL-REPARSE).
// getProduct over the real createUnionDetailUpstream and a fake of the union's three calls, with
// synthetic data only. Every fixture builds the reparser first, so on the skeleton every case stops
// at NotImplemented, the negative ones included. The reparser is built and handed on, never called:
// its members are the implementer's. Importing @couli/db/testing is the *.int.test.ts files' part.
import { setTimeout as delay } from 'node:timers/promises';
import { expect, vi } from 'vitest';
import type {
  PoolCandidate,
  PoolReader,
} from '../../../../apps/api/src/modules/catalog/application/pool-read.ts';
import { createRawReparser } from '../../../../apps/api/src/modules/catalog/application/raw-reparse.ts';
import {
  getProduct,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { createUnionDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/detail-wiring.ts';
import { cacheDetailUpstream } from '../../../../apps/api/src/modules/catalog/infra/product-cache.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  GovernanceError,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type UnionAdapter,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { memoryRedis } from '../cache/kit.ts';
import { APP_ID, NOW, PRODUCT_KEY, fixture, item, productRef } from '../detail/kit.ts';

/** BR-PROD-05: a raw ID is fresh up to and including this age. */
export const FRESH_MS = 1_800_000;
export const NEW_RAW = 'synthetic-renewed-synthetic001';
export const STORED_RAW = 'synthetic-stored-synthetic001';
export const STORED_TITLE = '合成引用标题';
export const POOL_TITLE = '合成池标题';
export const CANONICAL_URL = 'https://item.example.test/synthetic?id=synthetic001';
/** Apart from the union's 2990: tells the pool's card from a union answer and a cache entry. */
export const POOL_FINAL_FEN = 2500;
/** A hung call has this long to come back: a second past the 3 s of 重新解析步骤 3. */
export const HANG_LIMIT_MS = 4000;
/** A hung call does not come back before this: a real 3 s timer, with room for its rounding. */
const TIMEOUT_FLOOR_MS = 2900;

const JD_MODE_KEY = 'product_key.jd.mode';
const HIT_WINDOW_KEY = 'search.cache_ttl_sec';
/** Hit window of a cached case; the default stale window (300 s) stays open after it. */
const HIT_WINDOW_SEC = 60;

export function agoIso(ms: number): string {
  return new Date(Date.parse(NOW) - ms).toISOString();
}

/** Older than step ②'s limit by one millisecond. */
export const AGED = agoIso(FRESH_MS + 1);
export const POOL_QUOTED_AT = agoIso(FRESH_MS);

/** The union's answer for the target key under the new raw ID. */
export function found(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return item({ item_id: NEW_RAW, ...overrides });
}

export function onePage(items: readonly UnionItemDetail[] = [found()]) {
  return { items, nextCursor: null };
}

/** The union: it finds the product by title or link under NEW_RAW and answers its detail. */
export function unionFake() {
  const searchItems = vi.fn<UnionAdapter['searchItems']>(async () => onePage());
  const getItem = vi.fn<UnionAdapter['getItem']>(async () => found());
  const resolveLink = vi.fn<UnionAdapter['resolveLink']>(async () => ({
    item: { platform: 'taobao', item_id: NEW_RAW },
  }));
  const adapter = {
    platform: 'taobao',
    searchItems,
    getItem,
    resolveLink,
  } as unknown as UnionAdapter;
  return { union: { adapter: () => adapter }, searchItems, getItem, resolveLink };
}

export type UnionFake = ReturnType<typeof unionFake>;

export function poolCandidate(appId: string, productKey: string): PoolCandidate {
  return {
    item: item({
      title: POOL_TITLE,
      price_fen: 3990n,
      coupon_fen: 1490n,
      final_price_fen: BigInt(POOL_FINAL_FEN),
      quoted_at: POOL_QUOTED_AT,
    }),
    ref: {
      appId,
      platform: 'taobao',
      productKey,
      rawItemId: 'synthetic-pool-synthetic001',
      rawFetchedAt: agoIso(3 * 86_400_000),
      receivedAt: agoIso(3 * 86_400_000),
      canonicalUrl: null,
      title: POOL_TITLE,
      shopId: null,
      shopType: null,
      source: 'pool',
    },
  };
}

export interface ReparseSetup {
  readonly appId?: string;
  readonly productKey?: string;
  /** The app's product_refs row, stale unless told otherwise; null means it has none. */
  readonly stored?: Partial<ProductRef> | null;
  /** A qualifying pool row of the key. */
  readonly pooled?: boolean;
  /** The lock's store: absent, there is no Redis. */
  readonly redis?: RedisNamespace | null;
  /** Another union than a new fake: two instances over one union. */
  readonly fake?: UnionFake;
  /** The detail cache sits in front, with a short hit window. */
  readonly cached?: boolean;
  readonly jdMode?: 'item' | 'sku';
}

export function reparseFixture(setup: ReparseSetup = {}) {
  const base = fixture();
  const { appId = APP_ID, productKey = PRODUCT_KEY, jdMode = 'item' } = setup;
  const fake = setup.fake ?? unionFake();
  const memory = memoryRedis();
  const config: CatalogConfigReader = {
    configValue: async (id, key) => {
      if (key === JD_MODE_KEY) return { value: jdMode, version: 1 };
      if (key === HIT_WINDOW_KEY) return { value: HIT_WINDOW_SEC, version: 1 };
      return base.options.config.configValue(id, key);
    },
  };
  const direct = createUnionDetailUpstream({
    union: fake.union,
    reparser: createRawReparser({
      union: fake.union,
      clock: base.clock,
      catalog: base.options.catalog,
      redis: setup.redis ?? null,
    }),
  });
  const upstream =
    setup.cached === true
      ? cacheDetailUpstream(direct, { redis: memory.redis, clock: base.clock, config })
      : direct;

  const stored =
    setup.stored === null
      ? null
      : productRef({
          appId,
          productKey,
          rawItemId: STORED_RAW,
          title: STORED_TITLE,
          rawFetchedAt: AGED,
          receivedAt: AGED,
          ...setup.stored,
        });
  const pooled = setup.pooled === true ? poolCandidate(appId, productKey) : null;
  const poolDetail = vi.fn<PoolReader['detail']>(async () => pooled);
  const poolReader: PoolReader = {
    page: async () => null,
    fallbackPoolId: async () => null,
    detail: poolDetail,
  };
  base.current.mockResolvedValue({
    appId,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  });
  base.readProductRef.mockResolvedValue(stored);
  const options: ProductDetailOptions = { ...base.options, config, upstream, poolReader };
  /** An entry of this age under NEW_RAW, every mock back at zero calls. */
  const warm = async (ageSec: number): Promise<void> => {
    await getProduct(
      { product_key: productKey, item_ref: base.issue({ rawItemId: NEW_RAW }) },
      options,
    );
    base.clock.advanceMs(ageSec * 1000);
    base.readProductRef.mockClear();
    base.registerProductRef.mockClear();
    fake.getItem.mockClear();
    base.rows.length = 0;
  };
  return {
    ...fake,
    fake,
    clock: base.clock,
    issue: base.issue,
    readProductRef: base.readProductRef,
    registerProductRef: base.registerProductRef,
    register: base.register,
    rows: base.rows,
    quote: base.quote,
    poolDetail,
    memory,
    options,
    run(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: productKey, ...query }, options);
    },
    /** Past its hit window and inside the stale window. */
    warmCache: () => warm(HIT_WINDOW_SEC + 60),
    /** Inside its hit window. */
    warmHit: () => warm(HIT_WINDOW_SEC - 30),
  };
}

export type ReparseFixture = ReturnType<typeof reparseFixture>;

/** The union calls that count as asking it about this product. */
export function unionCalls(fake: UnionFake): number {
  return (
    fake.searchItems.mock.calls.length +
    fake.getItem.mock.calls.length +
    fake.resolveLink.mock.calls.length
  );
}

/** The raw IDs getItem was asked with. */
export function askedRaws(fake: UnionFake): (string | null | undefined)[] {
  return fake.getItem.mock.calls.map(
    ([ref]) => ref.item_id ?? ref.itemId ?? ref.skuId ?? ref.goods_sign,
  );
}

/** Every failure of 结果分类 ③ that reaches the detail: union errors and the governor's. */
export function outages() {
  return [
    {
      label: 'upstream_unavailable',
      error: new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    },
    {
      label: 'rate_limited',
      error: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
    },
    {
      label: '治理超时',
      error: new GovernanceError('timeout', 'union:taobao:online', 'synthetic timeout'),
    },
    {
      label: '熔断',
      error: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic open'),
    },
    {
      label: '配额耗尽',
      error: new GovernanceError('quota_exceeded', 'union:taobao:online', 'synthetic quota'),
    },
  ];
}

export function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}

export type Settled =
  | { readonly state: 'resolved'; readonly value: unknown }
  | { readonly state: 'rejected'; readonly error: unknown }
  | { readonly state: 'hung' };

/** How `run` ended within `ms`: a call that hangs fails an assertion, it does not time out. */
async function within(ms: number, run: () => Promise<unknown>): Promise<Settled> {
  const ended = run().then(
    (value): Settled => ({ state: 'resolved', value }),
    (error: unknown): Settled => ({ state: 'rejected', error }),
  );
  return Promise.race([ended, delay(ms).then((): Settled => ({ state: 'hung' }))]);
}

/** How `run` over a hung union ended: not before the 3 s of 重新解析步骤 3, not long after them. */
export async function waitedOut(run: () => Promise<unknown>): Promise<Settled> {
  const started = performance.now();
  const ended = await within(HANG_LIMIT_MS, run);
  expect(performance.now() - started).toBeGreaterThanOrEqual(TIMEOUT_FLOOR_MS);
  return ended;
}
