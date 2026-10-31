// B1-28h: cache of the hot-sales list union side (规划/01 F-PROD-13 ⑥): answers are cached per
// (platform, channel, category, page) for rank.cache_ttl_seconds; on a union failure an existing
// entry is read, a page marked stale (BR-PROD-07), without one the failure propagates (the use case
// answers 50304). An old page answers only while its age is within pool.max_age_sec (BR-PRICE-11,
// D10-508); past that it counts as absent. Categories carry no price and have no such limit.
// Like the search cache (product-cache.ts) only the union's normalized public data is stored —
// the item allow-list, the product ref, the sales field and the page's positions when it has
// them — plus fetched_at; cards, quotes and links are assembled per request by the use case.
// Freshness is decided by fetched_at against the configured TTL, never by the physical Redis TTL,
// which only cleans up. Without Redis (no provider, or RedisUnavailableError on a command) the
// union is read directly (02 §14).
import { createHash } from 'node:crypto';
import { RedisUnavailableError, type Clock, type RedisNamespace } from '../../platform/index.ts';
import type {
  HotRankCandidate,
  HotRankCategoryEntry,
  HotRankUpstream,
  HotRankUpstreamPage,
} from '../hot-rank.ts';
import type { CatalogConfigReader } from '../ports.ts';
import {
  Unreadable,
  isDependencyFailure,
  loadItem,
  loadRef,
  storeItem,
  storeRef,
} from './product-cache.ts';

export interface HotRankCacheOptions {
  readonly redis: RedisNamespace | null;
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
}

/** Redis namespace of the hot list cache; every key starts with the app_id. */
export const HOT_RANK_CACHE_NAMESPACE = 'catalog-rank';
/** 规划/01 F-PROD-13 ⑥: rank.cache_ttl_seconds, default 10 minutes (registered by B1-28g). */
const TTL_KEY = 'rank.cache_ttl_seconds';
const DEFAULT_TTL_SECONDS = 600;
/** BR-PRICE-11: pool.max_age_sec, default 7200 seconds. */
const MAX_AGE_KEY = 'pool.max_age_sec';
const DEFAULT_MAX_AGE_SECONDS = 7200;
/**
 * Physical Redis TTL beyond the hit window: how long an expired entry can still answer a union
 * failure (F-PROD-13 ⑥「联盟故障时有缓存读缓存」; 08 未定，技术取值, one day).
 */
const OUTAGE_KEEP_SECONDS = 86_400;
/** Format version of the stored JSON; another version reads as a miss. */
const ENTRY_VERSION = 1;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function secondsOf(
  config: CatalogConfigReader,
  appId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const entry = await config.configValue(appId, key);
  const value = entry?.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function keyOf(appId: string, kind: 'categories' | 'page', parts: readonly unknown[]): string {
  const digest = createHash('sha1').update(JSON.stringify(parts), 'utf8').digest('hex');
  return `${appId}:rank:${kind}:${digest}`;
}

function loadCategories(value: unknown): HotRankCategoryEntry[] {
  if (!Array.isArray(value)) throw new Unreadable();
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry['category_id'] !== 'string' ||
      typeof entry['name'] !== 'string'
    ) {
      throw new Unreadable();
    }
    return { categoryId: entry['category_id'], name: entry['name'] };
  });
}

/** Same shape as HotRankUpstreamPage.positions: anything else reads as unreadable. */
function loadPositions(value: unknown, itemCount: number): number[] {
  if (!Array.isArray(value) || value.length !== itemCount) throw new Unreadable();
  const positions: number[] = [];
  for (const position of value as unknown[]) {
    if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0) {
      throw new Unreadable();
    }
    if (position <= (positions.at(-1) ?? -1)) throw new Unreadable();
    positions.push(position);
  }
  return positions;
}

function loadPage(value: unknown): HotRankUpstreamPage {
  if (!isRecord(value) || typeof value['has_more'] !== 'boolean') throw new Unreadable();
  const items = value['items'];
  if (!Array.isArray(items)) throw new Unreadable();
  return {
    ...('positions' in value ? { positions: loadPositions(value['positions'], items.length) } : {}),
    hasMore: value['has_more'],
    items: items.map((entry: unknown): HotRankCandidate => {
      if (!isRecord(entry)) throw new Unreadable();
      const sales = entry['sales_text'];
      if (typeof sales !== 'string' && sales !== null) throw new Unreadable();
      return { item: loadItem(entry['item']), ref: loadRef(entry['ref']), salesText: sales };
    }),
  };
}

interface Entry<T> {
  readonly fetchedAtMs: number;
  readonly value: T;
}

export function cacheHotRankUpstream(
  upstream: HotRankUpstream,
  options: HotRankCacheOptions,
): HotRankUpstream {
  const { redis, clock, config } = options;

  async function read<T>(key: string, load: (value: unknown) => T): Promise<Entry<T> | null> {
    let text: string | null;
    try {
      text = await redis!.get(key);
    } catch (error: unknown) {
      if (error instanceof RedisUnavailableError) return null;
      throw error;
    }
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        !isRecord(parsed) ||
        parsed['v'] !== ENTRY_VERSION ||
        typeof parsed['fetched_at_ms'] !== 'number' ||
        !Number.isFinite(parsed['fetched_at_ms'])
      ) {
        return null;
      }
      return { fetchedAtMs: parsed['fetched_at_ms'], value: load(parsed['data']) };
    } catch {
      // Unparsable or another shape: a miss, overwritten by the next union answer.
      return null;
    }
  }

  async function write(key: string, data: unknown, ttlSeconds: number): Promise<void> {
    const text = JSON.stringify({ v: ENTRY_VERSION, fetched_at_ms: clock.now().getTime(), data });
    try {
      await redis!.set(key, text, ttlSeconds + OUTAGE_KEEP_SECONDS);
    } catch (error: unknown) {
      if (!(error instanceof RedisUnavailableError)) throw error;
    }
  }

  /** Hit inside the TTL; otherwise the union, and on its dependency failure a usable old entry. */
  async function cached<T>(
    appId: string,
    key: string,
    load: (value: unknown) => T,
    fetch: () => Promise<T>,
    store: (value: T) => unknown,
    old: (value: T) => T = (value) => value,
    usable: (ageMs: number) => Promise<boolean> = async () => true,
  ): Promise<T> {
    const ttlSeconds = await secondsOf(config, appId, TTL_KEY, DEFAULT_TTL_SECONDS);
    const entry = await read(key, load);
    if (entry !== null && clock.now().getTime() - entry.fetchedAtMs <= ttlSeconds * 1000) {
      return entry.value;
    }
    let value: T;
    try {
      value = await fetch();
    } catch (error: unknown) {
      if (
        entry !== null &&
        isDependencyFailure(error) &&
        (await usable(clock.now().getTime() - entry.fetchedAtMs))
      ) {
        return old(entry.value);
      }
      throw error;
    }
    await write(key, store(value), ttlSeconds);
    return value;
  }

  return {
    categories(input) {
      if (redis === null) return upstream.categories(input);
      return cached(
        input.appId,
        keyOf(input.appId, 'categories', [input.platform, input.channelId]),
        loadCategories,
        () => upstream.categories(input),
        (list) => list.map((entry) => ({ category_id: entry.categoryId, name: entry.name })),
      );
    },
    page(input) {
      if (redis === null) return upstream.page(input);
      return cached(
        input.appId,
        keyOf(input.appId, 'page', [
          input.platform,
          input.channelId,
          input.categoryId,
          input.pageNo,
          input.pageSize,
        ]),
        loadPage,
        () => upstream.page(input),
        (page) => ({
          has_more: page.hasMore,
          items: page.items.map((entry) => ({
            item: storeItem(entry.item),
            ref: storeRef(entry.ref),
            sales_text: entry.salesText,
          })),
          ...(page.positions === undefined ? {} : { positions: page.positions }),
        }),
        (page) => ({ ...page, stale: true }),
        async (ageMs) => {
          const maxAge = await secondsOf(config, input.appId, MAX_AGE_KEY, DEFAULT_MAX_AGE_SECONDS);
          return ageMs <= maxAge * 1000;
        },
      );
    },
  };
}
