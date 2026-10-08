import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../platform/index.ts';
import { UnionError, type UnionItem, type UnionItemDetail } from '../union/index.ts';
import type { CardQuoteContext } from './application/card-assembler.ts';
import { createCatalogCardEntry } from './application/card-entry.ts';
import { createItemRefService } from './application/item-ref.ts';
import { getProduct, type ProductDetailOptions, type ProductDetailRequest } from './detail.ts';
import { CatalogError, isPlatformServed } from './domain/rules.ts';
import type { PlatformRecord, ProductCapabilities, ProductRef } from './domain/types.ts';
import { createProcessItemRefCipher } from './infra/search-wiring.ts';
import type { Viewer } from './ports.ts';

const NOW = '2026-10-08T12:00:00+08:00';
const APP_ID = 'synthetic_detail_unit';
const PRODUCT_KEY = 'tb:synthetic001';
const RAW_ID = 'synthetic-card-prefix-synthetic001';

function platformRows(): PlatformRecord[] {
  return ['taobao', 'jd', 'pdd'].map((code) => ({
    code,
    key_prefix: code === 'taobao' ? 'tb' : code,
    key_stability: 'unverified' as const,
    search_support: 'supported',
    convert_support: 'supported',
    order_sync_support: 'supported',
    stage: 'M',
  })) as PlatformRecord[];
}

function item(overrides: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: RAW_ID,
    title: '合成详情商品',
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: NOW,
    ...overrides,
  };
}

/** Every runtime switch reads as off: the default state of search.enabled.<platform> (BR-PROD-10). */
function setup(detail: (request: ProductDetailRequest) => Promise<UnionItemDetail>) {
  const clock = new FixedClock(NOW);
  const viewer: Viewer = {
    appId: APP_ID,
    userId: 'synthetic_viewer',
    deviceId: 'synthetic_device',
  } as Viewer;
  const current = async (): Promise<Viewer> => viewer;
  const itemRefs = createItemRefService({ crypto: createProcessItemRefCipher() });
  const rows = platformRows();
  const upstream = vi.fn(detail);
  // Mirrors Catalog.registerProductRef's serving check (30131 when the platform is not served).
  const registerProductRef = vi.fn(async (ref: ProductRef, capabilities: ProductCapabilities) => {
    const record = rows.find((row) => row.code === ref.platform);
    if (record === undefined || !isPlatformServed(record, capabilities)) {
      throw new CatalogError(30131, 'catalog: platform not supported');
    }
  });
  const register = vi.fn(async () => ({ linkId: randomUUID() }));
  const options: ProductDetailOptions = {
    clock,
    viewerContext: { current },
    itemRefs,
    config: { configValue: async () => null },
    catalog: {
      listPlatforms: async () => rows,
      readProductRef: async () => null,
      registerProductRef,
    },
    upstream: { detail: upstream },
    cards: createCatalogCardEntry({
      clock,
      viewerContext: { current },
      itemRefs,
      registrar: { register },
      sourceLinks: { entrySource: async () => null },
      quoter: {
        quote: async (_item: UnionItem, _viewer: Viewer, context?: CardQuoteContext) => {
          const rebateBasis = context?.rebateBasis ?? 'normal';
          return {
            rebateMinFen: rebateBasis === 'normal' ? 269n : 135n,
            rebateMaxFen: 269n,
            estNetPriceFen: null,
            rebateBasis,
          };
        },
      },
      logger: { warn: vi.fn() },
    }),
  };
  const issue = (rawItemId: string) =>
    itemRefs.issue({
      appId: APP_ID,
      platform: 'taobao',
      productKey: PRODUCT_KEY,
      rawItemId,
      fetchedAt: NOW,
    });
  return { options, upstream, registerProductRef, register, issue };
}

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error: unknown) {
    return error instanceof CatalogError ? { code: error.code } : error;
  }
}

describe('getProduct (B1-05e, round 2)', () => {
  it('[AC-B1-05e] 搜索开关关闭（默认）时详情仍 200，不读 parse.enabled', async () => {
    const f = setup(async () => item());
    const card = await getProduct(
      { product_key: PRODUCT_KEY, item_ref: f.issue(RAW_ID) },
      f.options,
    );
    expect(card.product_key).toBe(PRODUCT_KEY);
    expect(typeof card.link_id).toBe('string');
    expect(f.registerProductRef).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(1);
  });

  it.each(['upstream_rejected', 'invalid_dto', 'link_unrecognized'] as const)(
    '[AC-B1-05e] 联盟以 %s 拒绝原串 → 30143（引用失效），不登记 link',
    async (code) => {
      const f = setup(async () => {
        throw new UnionError(code, 'synthetic refusal', 'taobao');
      });
      const result = await outcome(
        getProduct({ product_key: PRODUCT_KEY, item_ref: f.issue(RAW_ID) }, f.options),
      );
      expect(result).toEqual({ code: 30143 });
      expect(f.register).not.toHaveBeenCalled();
    },
  );

  it('[AC-B1-05e] 有效令牌作原串来源时原样返回，即使联盟同键换了原串', async () => {
    const f = setup(async () => item({ item_id: 'synthetic-new-prefix-synthetic001' }));
    const issued = f.issue('synthetic-old-raw');
    const card = await getProduct({ product_key: PRODUCT_KEY, item_ref: issued }, f.options);
    expect(f.upstream.mock.calls[0]?.[0].rawItemId).toBe('synthetic-old-raw');
    expect(card.item_ref).toBe(issued);
  });
});
