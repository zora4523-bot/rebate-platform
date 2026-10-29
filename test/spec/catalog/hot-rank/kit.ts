// B1-28h rule-test kit: GET /v1/rank/hot use case (getHotRank) over storage-only fakes.
// The union side is a fake of catalog's HotRankUpstream seam with synthetic data only: platform
// ranking capabilities (CAP-TB-10, CAP-JD-10, CAP-PDD-10) are not recorded yet, so no platform
// payload is imitated here (hard rule 7). Channels are synthetic whitelist entries handed to the
// use case; specs/material-channels.yaml itself is read only by the HTTP test of the real wiring.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { addFen } from '@couli/money';
import {
  createCatalogCardEntry,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  getHotRank,
  type HotRankCandidate,
  type HotRankCategoriesRequest,
  type HotRankCategoryEntry,
  type HotRankOptions,
  type HotRankPageRequest,
  type HotRankQuery,
  type HotRankUpstream,
  type HotRankUpstreamPage,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import type { CatalogConfigReader } from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  FixedClock,
  type MaterialChannelsSpec,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Platform, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-06T10:00:00+08:00';
export const APP = 'synthetic_rank';
/** Contract HotRankData.items maxItems and the description: page size 20, no limit parameter. */
export const PAGE_SIZE = 20;
/** 规划/01 F-PROD-13 ⑥: rank.cache_ttl_seconds default 10 minutes (seed 600, B1-28g). */
export const DEFAULT_TTL_SECONDS = 600;
export const TTL_KEY = 'rank.cache_ttl_seconds';
export const TB_CHANNEL = 'synthetic_tb_sales';

export type ChannelEntry = MaterialChannelsSpec['channels'][number];

/** A synthetic whitelist entry (sales by default); never a recorded platform channel. */
export function channel(
  platform: Platform,
  channelId: string,
  overrides: Partial<ChannelEntry> = {},
): ChannelEntry {
  return {
    platform,
    channel_id: channelId,
    name: `合成频道 ${channelId}`,
    sort_basis: 'sales',
    selectable: true,
    source: 'synthetic fixture, not a CAP record',
    ...overrides,
  };
}

function keyPrefix(platform: Platform): string {
  return platform === 'taobao' ? 'tb' : platform;
}

export interface CandidateOptions {
  readonly platform?: Platform;
  readonly salesText?: string | null;
  readonly finalFen?: bigint;
  readonly couponFen?: bigint;
}

/** One channel position; the card title is `synthetic-<name>`. */
export function candidate(name: string, options: CandidateOptions = {}): HotRankCandidate {
  const platform = options.platform ?? 'taobao';
  const final = options.finalFen ?? 1000n;
  const coupon = options.couponFen ?? 0n;
  const raw = `synthetic-${name}`;
  const plan = `synthetic-plan-${name}`;
  const item: UnionItem = {
    platform,
    item_id: raw,
    skuId: raw,
    goods_id: raw,
    goods_sign: plan,
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
      appId: APP,
      platform,
      productKey: `${keyPrefix(platform)}:${raw}`,
      rawItemId: platform === 'pdd' ? plan : raw,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: raw,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    salesText: options.salesText === undefined ? null : options.salesText,
  };
}

/** `count` candidates named `<prefix>-<n>` (sales `<n>件`) for n = start .. start + count − 1. */
export function series(prefix: string, count: number, start = 1, platform: Platform = 'taobao') {
  return Array.from({ length: count }, (_unused, index) =>
    candidate(`${prefix}-${start + index}`, { platform, salesText: `${start + index}件` }),
  );
}

function slot(...parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

/** Union side fake: stored answers per (platform, channel[, category, page]); no ordering logic. */
export function unionSide() {
  const categoryLists = new Map<string, HotRankCategoryEntry[]>();
  const pages = new Map<string, HotRankUpstreamPage>();
  let failure: Error | null = null;
  const categories = vi.fn(
    async (input: HotRankCategoriesRequest): Promise<HotRankCategoryEntry[]> => {
      if (failure !== null) throw failure;
      return structuredClone(categoryLists.get(slot(input.platform, input.channelId)) ?? []);
    },
  );
  const page = vi.fn(async (input: HotRankPageRequest): Promise<HotRankUpstreamPage> => {
    if (failure !== null) throw failure;
    const stored = pages.get(slot(input.platform, input.channelId, input.categoryId, input.pageNo));
    return structuredClone(stored ?? { items: [], hasMore: false });
  });
  const upstream: HotRankUpstream = { categories, page };
  return {
    upstream,
    categories,
    page,
    setCategories(platform: Platform, channelId: string, list: HotRankCategoryEntry[]) {
      categoryLists.set(slot(platform, channelId), list);
    },
    setPage(
      platform: Platform,
      channelId: string,
      categoryId: string | null,
      pageNo: number,
      items: readonly HotRankCandidate[],
      hasMore = false,
    ) {
      pages.set(slot(platform, channelId, categoryId, pageNo), { items: [...items], hasMore });
    },
    fail(error: Error | null) {
      failure = error;
    },
  };
}

/** Storage only: never expires rows, so freshness cannot rely on the physical TTL. */
export function memoryRedis() {
  const rows = new Map<string, string>();
  const get = vi.fn(async (key: string) => rows.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string, ttlSeconds: number) => {
    void ttlSeconds;
    rows.set(key, value);
  });
  const redis: RedisNamespace = {
    get,
    set,
    eval: vi.fn(async () => {
      throw new Error('Unexpected Lua on the hot list cache');
    }),
  };
  return { redis, rows, get, set };
}

export interface FixtureSetup {
  /** Wrap the union side in cacheHotRankUpstream (memory Redis, the fixture's clock and config). */
  readonly cached?: boolean;
}

export function fixture(setup: FixtureSetup = {}) {
  const clock = new FixedClock(NOW);
  const viewer: Viewer = { appId: APP, userId: null, deviceId: 'synthetic-device' };
  const current = vi.fn(async () => viewer);
  let version = 1;
  let spec: MaterialChannelsSpec = {
    version: `synthetic-${version}`,
    channels: [channel('taobao', TB_CHANNEL)],
  };
  const channels = vi.fn(() => spec);
  const union = unionSide();
  const memory = memoryRedis();
  const settings = new Map<string, number>();
  const configValue = vi.fn(async (_appId: string, key: string) =>
    settings.has(key) ? { value: settings.get(key)!, version: 1 } : null,
  );
  const config: CatalogConfigReader = { configValue };
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
  const upstream =
    setup.cached === true
      ? cacheHotRankUpstream(union.upstream, { redis: memory.redis, clock, config })
      : union.upstream;
  const options: HotRankOptions = {
    clock,
    viewerContext: { current },
    cards: { assemble },
    channels,
    upstream,
    logger: { warn },
  };
  return {
    ...union,
    options,
    clock,
    channels,
    memory,
    settings,
    configValue,
    quotes,
    quote,
    register,
    warn,
    assemble,
    setChannels(list: readonly ChannelEntry[]) {
      version += 1;
      spec = { version: `synthetic-${version}`, channels: [...list] };
    },
    run(query: Partial<HotRankQuery> = {}) {
      return getHotRank({ platform: 'taobao', ...query }, options);
    },
  };
}

/** The error an action ended with (a synchronous throw included); undefined when it resolved. */
export async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/** `data` of a 50304 / 20001 failure, or undefined. */
export function dataOf(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
}

const root = new URL('../../../../', import.meta.url);

export interface Contract {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, { get?: Record<string, unknown> }>;
}

export async function contract(): Promise<Contract> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<Contract>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
}

/** Validates a value against a dereferenced contract schema. */
export async function assertSchema(value: unknown, name: string): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema, name).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}
