import { vi } from 'vitest';
import { addFen } from '@couli/money';
import {
  createCatalogCardEntry,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  searchProducts,
  type SearchCandidate,
  type SearchCursor,
  type SearchProductsOptions,
  type SearchProductsQuery,
  type SearchSession,
  type SearchUpstreamPage,
  type SearchUpstreamRequest,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  Platform,
  UnionItem,
  UnionPidRow,
} from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-06T10:00:00+08:00';
export const QUERY: SearchProductsQuery = { platform: 'taobao', q: '合成纸巾', limit: 3 };

export function candidate(
  name: string,
  final: bigint = 1000n,
  coupon: bigint = 0n,
  platform: Platform = 'taobao',
): SearchCandidate {
  const raw = `synthetic-${name}`;
  const item: UnionItem = {
    platform,
    item_id: raw,
    skuId: raw,
    goods_id: raw,
    goods_sign: `synthetic-plan-${name}`,
    title: raw,
    price_fen: addFen(final, coupon),
    coupon_fen: coupon,
    final_price_fen: final,
    commission_rate_bp: 1000n,
    quoted_at: NOW,
  };
  return {
    item,
    ref: {
      appId: 'synthetic-app',
      platform,
      productKey: `${platform === 'taobao' ? 'tb' : platform}:${raw}`,
      rawItemId: platform === 'pdd' ? item.goods_sign! : raw,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: raw,
      shopId: null,
      shopType: null,
      source: 'search',
    },
  };
}

/** Storage fake deliberately has no expiry, ownership, query matching or deduplication logic. */
export function sessionStorage() {
  const rows = new Map<string, SearchSession>();
  const read = vi.fn(async (appId: string, id: string) =>
    structuredClone(rows.get(JSON.stringify([appId, id])) ?? null),
  );
  const write = vi.fn(async (appId: string, id: string, value: SearchSession, _ttl: number) => {
    void _ttl;
    rows.set(JSON.stringify([appId, id]), structuredClone(value));
  });
  return { rows, read, write };
}

/** An opaque codec fake records the entire payload, so hidden extra claims cannot pass. */
export function cursorCodec() {
  const payloads = new Map<string, unknown>();
  const encode = vi.fn((value: SearchCursor) => {
    const wire = `synthetic-cursor-${payloads.size + 1}`;
    payloads.set(wire, structuredClone(value));
    return wire;
  });
  const decode = vi.fn((wire: string): unknown => structuredClone(payloads.get(wire)));
  return { payloads, encode, decode };
}

export function fixture() {
  let viewer: Viewer = {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
  };
  const clock = new FixedClock(NOW);
  const current = vi.fn(async () => viewer);
  const enabled = new Map<Platform, boolean>([
    ['taobao', true],
    ['jd', true],
    ['pdd', true],
  ]);
  const configValue = vi.fn(async (_appId: string, key: string) => ({
    value: key.startsWith('search.enabled.')
      ? (enabled.get(key.slice('search.enabled.'.length) as Platform) ?? false)
      : false,
    version: 1,
  }));
  const getActivePid = vi.fn(
    async (
      input: Parameters<SearchProductsOptions['pids']['getActivePid']>[0],
    ): Promise<UnionPidRow | null> => ({
      id: 'synthetic-pid-row',
      app_id: input.appId,
      platform: input.platform,
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
    }),
  );
  const requirePlatform = vi.fn(async (code: string) => ({
    code,
    key_prefix: code === 'taobao' ? 'tb' : code,
    key_stability: 'stable_7d' as const,
    search_support: 'supported',
    convert_support: 'supported',
    order_sync_support: 'supported',
    stage: 'launched',
  }));
  const aliases = new Map<string, string>();
  const resolveProductKey = vi.fn(async (key: string) => aliases.get(key) ?? key);
  const pages = new Map<number, SearchUpstreamPage>();
  const search = vi.fn(async (input: SearchUpstreamRequest): Promise<SearchUpstreamPage> => {
    const page = pages.get(input.pageNo) ?? { items: [], hasMore: false };
    return structuredClone(page);
  });
  const materialFeed = vi.fn(async (): Promise<SearchUpstreamPage> => ({
    items: [],
    hasMore: false,
  }));
  const quotes = new Map<string, { min: bigint; max: bigint }>();
  const quote = vi.fn(
    async (item: UnionItem, _viewer: Viewer, context?: CardQuoteContext): Promise<RebateQuote> => {
      const bounds = quotes.get(item.title) ?? { min: 10n, max: 20n };
      const basis = context?.rebateBasis ?? 'normal';
      return {
        rebateMinFen: basis === 'normal' ? bounds.max : bounds.min,
        rebateMaxFen: bounds.max,
        estNetPriceFen: null,
        rebateBasis: basis,
      };
    },
  );
  let registered = 0;
  const register = vi.fn(async (input: RegisterLinkInput) => {
    void input;
    return { linkId: `00000000-0000-7000-8000-${String(++registered).padStart(12, '0')}` };
  });
  const warn = vi.fn();
  const entry = createCatalogCardEntry({
    clock,
    viewerContext: { current },
    quoter: { quote },
    registrar: { register },
    sourceLinks: { entrySource: vi.fn(async () => null) },
    itemRefs: { issue: vi.fn(() => 'synthetic-item-ref') },
    logger: { warn },
  });
  const assemble = vi.fn(entry.assemble);
  const sessions = sessionStorage();
  const cursors = cursorCodec();
  let ids = 0;
  const options: SearchProductsOptions = {
    clock,
    viewerContext: { current },
    config: { configValue },
    pids: { getActivePid },
    catalog: { requirePlatform, resolveProductKey },
    cards: { assemble },
    upstream: { search, materialFeed },
    sessions,
    cursors,
    newSessionId: () => `synthetic-session-${++ids}`,
    logger: { warn },
  };
  return {
    options,
    clock,
    enabled,
    configValue,
    getActivePid,
    requirePlatform,
    aliases,
    resolveProductKey,
    pages,
    search,
    materialFeed,
    quotes,
    quote,
    register,
    warn,
    assemble,
    sessions,
    cursors,
    setViewer(value: Partial<Viewer>) {
      viewer = { ...viewer, ...value };
    },
    run(query: Partial<SearchProductsQuery> = {}) {
      return searchProducts({ ...QUERY, ...query }, options);
    },
  };
}

export function claims(f: ReturnType<typeof fixture>, cursor: string | null): SearchCursor {
  // Missing cursor yields an ordinary assertion mismatch, never a JSON parsing TypeError.
  return f.cursors.payloads.get(cursor ?? '') as SearchCursor;
}

export async function observed<T>(action: () => Promise<T>) {
  try {
    return { kind: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { kind: 'rejected' as const, error };
  }
}
