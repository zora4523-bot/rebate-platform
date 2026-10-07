import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createCatalogCardEntry } from '../../../../apps/api/src/modules/catalog/application/card-entry.ts';
import type { CardQuoteContext } from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import { createItemRefService } from '../../../../apps/api/src/modules/catalog/application/item-ref.ts';
import type { ItemRefClaims } from '../../../../apps/api/src/modules/catalog/application/item-ref.ts';
import {
  getProduct,
  type ProductDetailOptions,
  type ProductDetailQuery,
  type ProductDetailRequest,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { ProductRef } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { createProcessItemRefCipher } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import type { RegisterLinkInput, Viewer } from '../../../../apps/api/src/modules/catalog/ports.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem, UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-08T12:00:00+08:00';
export const APP_ID = 'synthetic_detail';
export const PRODUCT_KEY = 'tb:synthetic001';
export const RAW_ID = 'synthetic-card-prefix-synthetic001';

export function item(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: RAW_ID,
    title: '合成详情商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: NOW,
    coupon_ids: 'synthetic-coupon',
    ...overrides,
  };
}

export function productRef(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    appId: APP_ID,
    platform: 'taobao',
    productKey: PRODUCT_KEY,
    rawItemId: 'synthetic-stored-prefix-synthetic001',
    rawFetchedAt: NOW,
    receivedAt: NOW,
    canonicalUrl: null,
    title: '合成详情商品',
    shopId: null,
    shopType: null,
    source: 'search',
    ...overrides,
  };
}

export function fixture() {
  const clock = new FixedClock(NOW);
  const viewer: Viewer = {
    appId: APP_ID,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  };
  const current = vi.fn(async (): Promise<Viewer> => viewer);
  const itemRefs = createItemRefService({ crypto: createProcessItemRefCipher() });
  const detail = vi.fn(async (request: ProductDetailRequest) => {
    void request;
    return item();
  });
  const readProductRef = vi.fn(async (): Promise<ProductRef | null> => null);
  const registerProductRef = vi.fn(async (ref: ProductRef) => {
    void ref;
  });
  const rows: (RegisterLinkInput & { linkId: string })[] = [];
  const register = vi.fn(async (input: RegisterLinkInput) => {
    const linkId = randomUUID();
    rows.push({ ...input, linkId });
    return { linkId };
  });
  const entrySource = vi.fn(async (appId: string, linkId: string): Promise<string | null> => {
    void appId;
    void linkId;
    return null;
  });
  // Deliberately fixed amounts: tests verify delegation and basis, not a second rebate formula.
  const quote = vi.fn(async (_item: UnionItem, _viewer: Viewer, context?: CardQuoteContext) => {
    const rebateBasis = context?.rebateBasis ?? 'normal';
    return {
      rebateMinFen: rebateBasis === 'normal' ? 269n : 135n,
      rebateMaxFen: 269n,
      estNetPriceFen: null,
      rebateBasis,
    };
  });
  const options: ProductDetailOptions = {
    clock,
    viewerContext: { current },
    itemRefs,
    config: {
      configValue: vi.fn(async (_appId: string, key: string) => {
        if (key === 'product_key.jd.mode') return { value: 'item', version: 1 };
        if (key.startsWith('search.enabled.') || key.startsWith('parse.enabled.')) {
          return { value: true, version: 1 };
        }
        return null;
      }),
    },
    catalog: {
      listPlatforms: async () =>
        ['taobao', 'jd', 'pdd'].map((code) => ({
          code,
          key_prefix: code === 'taobao' ? 'tb' : code,
          key_stability: 'unverified' as const,
          search_support: 'supported',
          convert_support: 'supported',
          order_sync_support: 'supported',
          stage: 'M',
        })),
      readProductRef,
      registerProductRef,
    },
    upstream: { detail },
    cards: createCatalogCardEntry({
      clock,
      viewerContext: { current },
      itemRefs,
      registrar: { register },
      sourceLinks: { entrySource },
      quoter: { quote },
      logger: { warn: vi.fn() },
    }),
  };
  return {
    clock,
    current,
    itemRefs,
    detail,
    readProductRef,
    registerProductRef,
    rows,
    register,
    entrySource,
    quote,
    options,
    issue(overrides: Partial<ItemRefClaims> = {}) {
      return itemRefs.issue({
        appId: APP_ID,
        platform: 'taobao',
        productKey: PRODUCT_KEY,
        rawItemId: RAW_ID,
        fetchedAt: NOW,
        ...overrides,
      });
    },
    get(query: Partial<ProductDetailQuery> = {}) {
      return getProduct({ product_key: PRODUCT_KEY, ...query }, options);
    },
  };
}
