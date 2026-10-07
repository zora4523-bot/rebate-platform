import { vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
  type CardQuoteContext,
  type PlatformRecord,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createParsing,
  type ParsingOptions,
  type ParsingResult,
} from '../../../../apps/api/src/modules/parsing/index.ts';
import {
  FixedClock,
  type LinkPatternsSpec,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  UnionError,
  type CallCtx,
  type ItemRef,
  type RegisteredPlatform,
  type ResolvedLink,
  type UnionAdapter,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { ManualScheduler } from '../../platform/http/kit.ts';

// Only synthetic domain DTOs and reserved hosts, never platform recordings.
export const TABLE: LinkPatternsSpec = {
  version: 'synthetic-parsing-1',
  rules: [
    { platform: 'taobao', category: 'union_host', hosts: ['tb.example.test'], path_patterns: [] },
    {
      platform: 'taobao',
      category: 'product',
      hosts: ['tb.example.test'],
      path_patterns: ['/item/*', '/literal/a.b', '/deep/**'],
    },
    {
      platform: 'taobao',
      category: 'promo',
      hosts: ['promo.example.test'],
      path_patterns: ['/s/**'],
    },
    { platform: 'jd', category: 'union_host', hosts: ['jd.example.test'], path_patterns: [] },
    { platform: 'jd', category: 'product', hosts: ['jd.example.test'], path_patterns: ['/item/*'] },
    { platform: 'pdd', category: 'union_host', hosts: ['pdd.example.test'], path_patterns: [] },
    {
      platform: 'pdd',
      category: 'product',
      hosts: ['pdd.example.test'],
      path_patterns: ['/item/*'],
    },
    { platform: 'vip', category: 'union_host', hosts: ['vip.example.test'], path_patterns: [] },
    {
      platform: 'vip',
      category: 'product',
      hosts: ['vip.example.test'],
      path_patterns: ['/item/*'],
    },
  ],
};
export const CTX: CallCtx = {
  appId: 'synthetic-app',
  requestId: 'synthetic-request',
  purpose: 'online',
};
export const URL_A = 'https://tb.example.test/item/a?other_pid=synthetic-promoter';
export const URL_B = 'https://jd.example.test/item/b';
export const URL_C = 'https://pdd.example.test/item/c';
export const URL_D = 'https://tb.example.test/item/d';
export const TPWD = '￥SyntheticA￥';
export const QUOTED_AT = '2026-10-06T01:00:00.000Z';
export const NOW = '2026-10-06T01:01:00.000Z';

export function item(ref: ItemRef, patch: Partial<UnionItemDetail> = {}): UnionItemDetail {
  return {
    ...ref,
    title: '合成商品',
    price_fen: 12000n,
    coupon_fen: 2000n,
    final_price_fen: 10000n,
    commission_rate_bp: 1000n,
    quoted_at: QUOTED_AT,
    ...patch,
  };
}

export function fixture() {
  const refs = new Map<string, ItemRef>([
    [URL_A, { platform: 'taobao', item_id: 'synthetic-prefix-a' }],
    [URL_B, { platform: 'jd', itemId: 'synthetic_b_tail', skuId: 'sku-b' }],
    [URL_C, { platform: 'pdd', goods_id: 'c', goods_sign: 'synthetic-plan-c' }],
    [URL_D, { platform: 'taobao', item_id: 'synthetic-prefix-d' }],
    [TPWD, { platform: 'taobao', item_id: 'synthetic-prefix-a' }],
  ]);
  const config = new Map<string, boolean | string>([
    ['parse.tpwd.enabled', true],
    ['product_key.jd.mode', 'item'],
  ]);
  const configValue = vi.fn(async (_appId: string, key: string) => {
    const value = config.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  const aliases = new Map<string, string>();
  const resolveProductKey = vi.fn(async (key: string) => aliases.get(key) ?? key);
  const platforms: PlatformRecord[] = ['taobao', 'jd', 'pdd', 'vip'].map((code) => ({
    code,
    key_prefix: code === 'taobao' ? 'tb' : code,
    key_stability: 'unverified',
    search_support: 'full',
    convert_support: 'full',
    order_sync_support: 'full',
    stage: 'demo',
  }));
  const listPlatforms = vi.fn(async () => platforms);
  const resolveLink = vi.fn(async (raw: string, _context: CallCtx): Promise<ResolvedLink> => {
    void _context;
    const ref = refs.get(raw);
    if (ref === undefined) throw new UnionError('link_unrecognized', 'synthetic unresolved input');
    return { item: ref };
  });
  const getItem = vi.fn(async (ref: ItemRef, context: CallCtx) => {
    void context;
    return item(ref);
  });
  const convert = vi.fn<UnionAdapter['convert']>();
  const searchItems = vi.fn<UnionAdapter['searchItems']>();
  const clock = new FixedClock(NOW);
  const viewer = { appId: CTX.appId, userId: 'synthetic-user', deviceId: 'synthetic-device' };
  const quote = vi.fn(
    async (
      _item: UnionItemDetail,
      _viewer: Viewer,
      context?: CardQuoteContext,
    ): Promise<RebateQuote> => ({
      rebateMinFen: 300n,
      rebateMaxFen: 300n,
      estNetPriceFen: null,
      rebateBasis: context?.rebateBasis ?? 'normal',
    }),
  );
  const register = vi.fn(async (input: RegisterLinkInput) => ({
    linkId: `synthetic-link:${input.ref.productKey}`,
  }));
  const cardEntry = createCatalogCardEntry({
    clock,
    viewerContext: { current: async () => viewer },
    quoter: { quote },
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: { warn: vi.fn() },
  });
  const assemble = vi.fn((input: CatalogCardInput) => cardEntry.assemble(input));
  const scheduler = new ManualScheduler();
  const adapters = new Map<RegisteredPlatform, UnionAdapter>();
  for (const platform of ['taobao', 'jd', 'pdd'] as const) {
    adapters.set(
      platform,
      createGovernedAdapter(
        {
          platform,
          resolveLink,
          getItem,
          convert,
          searchItems,
          listOrders: async () => ({ items: [], nextCursor: null }),
        },
        {
          endpoint: { platform, mode: 'demo', baseUrl: null, quotaKey: `synthetic:${platform}` },
          quota: { bucketKey: `synthetic:${platform}`, tryAcquire: () => true },
          scheduler,
        },
      ),
    );
  }
  const getGovernedAdapter = vi.fn((platform: RegisteredPlatform) => {
    const adapter = adapters.get(platform);
    if (adapter === undefined)
      throw new UnionError('adapter_unimplemented', 'synthetic unavailable platform');
    return adapter;
  });
  const options: ParsingOptions = {
    config: { configValue },
    catalog: { listPlatforms, resolveProductKey },
    cards: { assemble },
    clock,
    getGovernedAdapter,
    linkPatterns: TABLE,
  };
  return {
    options,
    refs,
    config,
    configValue,
    aliases,
    platforms,
    resolveProductKey,
    resolveLink,
    getItem,
    getGovernedAdapter,
    convert,
    searchItems,
    assemble,
    register,
    quote,
    viewer,
    run: (text: string, ctx: CallCtx = CTX) => createParsing(options).parseInput(text, ctx),
  };
}

export function cards(results: readonly ParsingResult[]) {
  return results.flatMap((result) => (result.kind === 'card' ? [result.card] : []));
}

/** Rejections are observed as data; unexpected exceptions fail an assertion. */
export async function observed<T>(action: () => T | Promise<T>) {
  try {
    return { outcome: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { outcome: 'rejected' as const, error };
  }
}
