import { vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
  type CatalogCardScene,
  type CardAssemblerOptions,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';

export const QUOTED_AT = '2026-10-06T10:00:00+08:00';
export const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

export function item(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'taobao',
    item_id: 'synthetic-item',
    title: '合成价格状态商品',
    price_fen: 12000n,
    coupon_fen: 2000n,
    final_price_fen: 10000n,
    commission_rate_bp: 1000n,
    quoted_at: QUOTED_AT,
    ...overrides,
  };
}

export function input(
  value: UnionItem,
  scene: CatalogCardScene,
  entrySource: string | null = 'search',
): CatalogCardInput {
  const prefix = value.platform === 'taobao' ? 'tb' : value.platform;
  return {
    item: value,
    scene,
    entrySource,
    stale: false,
    ref: {
      appId: 'synthetic-app',
      platform: value.platform,
      productKey: `${prefix}:${value.item_id ?? 'synthetic-item'}`,
      rawItemId: value.item_id ?? 'synthetic-item',
      rawFetchedAt: value.quoted_at,
      receivedAt: value.quoted_at,
      canonicalUrl: null,
      title: value.title,
      shopId: null,
      shopType: null,
      source: scene === 'retrieval' ? 'search' : 'detail',
    },
  };
}

export function ports() {
  const viewer: Viewer = {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
  };
  const clock = new FixedClock('2026-10-06T10:05:00+08:00');
  const current = vi.fn(async () => viewer);
  const quote = vi.fn(
    async (
      _item: UnionItem,
      _viewer: Viewer,
      context?: CardQuoteContext,
    ): Promise<RebateQuote> => ({
      rebateMinFen: context?.rebateBasis === 'normal' ? 433n : 211n,
      rebateMaxFen: 433n,
      estNetPriceFen: null,
      rebateBasis: context?.rebateBasis ?? 'normal',
    }),
  );
  const register = vi.fn(async (value: RegisterLinkInput) => ({
    linkId: `synthetic-link:${value.ref.productKey}`,
  }));
  const entrySource = vi.fn(async (): Promise<string | null> => 'feed');
  const issue = vi.fn(() => 'synthetic-item-ref');
  const warn = vi.fn();
  const options = {
    clock,
    viewerContext: { current },
    quoter: { quote },
    registrar: { register },
    sourceLinks: { entrySource },
    itemRefs: { issue },
    logger: { warn },
  } satisfies CardAssemblerOptions & { logger: { warn: typeof warn } };
  return { options, viewer, clock, quote, register, entrySource, issue, warn };
}

export function fixture() {
  const f = ports();
  return { ...f, service: createCatalogCardEntry(f.options) };
}

/** Convert old-code rejection to a value so a missing branch fails an assertion. */
export async function observed<T>(action: () => Promise<T>) {
  try {
    return { outcome: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { outcome: 'rejected' as const, error };
  }
}

/** Invalid adapter outputs are synthetic; casts exercise missing/wrong runtime fields. */
export const ANOMALIES: readonly { name: string; value: UnionItem }[] = [
  {
    name: 'union 明确异常且三字段清零',
    value: item({ price_status: 'anomaly', price_fen: 0n, coupon_fen: 0n, final_price_fen: 0n }),
  },
  { name: 'union 明确异常优先于看似合法的三字段', value: item({ price_status: 'anomaly' }) },
  { name: '缺少券前价', value: { ...item(), price_fen: undefined } as unknown as UnionItem },
  { name: '缺少券面额', value: { ...item(), coupon_fen: undefined } as unknown as UnionItem },
  { name: '缺少券后价', value: { ...item(), final_price_fen: undefined } as unknown as UnionItem },
  { name: '字符串券前价', value: { ...item(), price_fen: '12000' } as unknown as UnionItem },
  { name: '券前价为零', value: item({ price_fen: 0n, coupon_fen: 0n, final_price_fen: 0n }) },
  { name: '券前价为负', value: item({ price_fen: -1n, coupon_fen: 0n, final_price_fen: -1n }) },
  { name: '负券额', value: item({ coupon_fen: -1n, final_price_fen: 12001n }) },
  { name: '券等于售价', value: item({ coupon_fen: 12000n, final_price_fen: 0n }) },
  { name: '券大于售价', value: item({ coupon_fen: 12001n, final_price_fen: -1n }) },
  { name: '券后价为零', value: item({ final_price_fen: 0n }) },
  { name: '券后价为负', value: item({ final_price_fen: -1n }) },
  { name: '恒等式差一分', value: item({ final_price_fen: 10001n }) },
  { name: 'ok 状态不能豁免恒等式', value: item({ price_status: 'ok', final_price_fen: 9999n }) },
];
