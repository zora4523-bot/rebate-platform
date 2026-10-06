// B1-05d public search use case. Tests call this file directly; no forwarding-only entry.
// The HTTP controller will supply contract-validated query parameters and server-owned ports.
import type { components, operations } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import { GovernanceError, getMaterialChannels, type Clock } from '../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isPriceAnomaly,
  type Platform,
  type UnionItem,
  type UnionPidService,
} from '../union/index.ts';
import type { ProductCard } from './application/card-assembler.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import { CatalogError } from './domain/rules.ts';
import type { Catalog, ProductRef } from './domain/types.ts';
import type { CatalogConfigReader, Viewer, ViewerContext } from './ports.ts';

export type SearchProductsQuery = operations['searchProducts']['parameters']['query'];
export type SearchProductsData = components['schemas']['SearchProductsData'];

export interface SearchCursor {
  readonly search_session_id: string;
  readonly page_no: number;
}

/** Encoding is deliberately opaque to clients; only these two claims may be encoded. */
export interface SearchCursorCodec {
  encode(value: SearchCursor): string;
  decode(value: string): unknown;
}

/** Normalized union public page, before caller-specific filtering or session deduplication. */
export interface SearchCandidate {
  readonly item: UnionItem;
  readonly ref: ProductRef;
}

export interface SearchUpstreamRequest {
  readonly appId: string;
  readonly platform: Platform;
  readonly keyword: string;
  readonly pageNo: number;
  readonly pageSize: number;
  readonly sort: 'relevance' | 'sales_desc';
  readonly hasCoupon?: boolean;
  readonly priceMinFen?: number;
  readonly promotionSlot: string;
}

export interface SearchUpstreamPage {
  readonly items: readonly SearchCandidate[];
  readonly hasMore: boolean;
}

/** Adapter/cache seam: B1-05g owns caching, not this use case. No product-pool fallback. */
export interface SearchUpstream {
  search(input: SearchUpstreamRequest): Promise<SearchUpstreamPage>;
  materialFeed(input: {
    readonly appId: string;
    readonly platform: Platform;
    readonly channelId: string;
    readonly limit: number;
    readonly promotionSlot: string;
  }): Promise<SearchUpstreamPage>;
}

export interface SearchSession {
  readonly appId: string;
  readonly requester: string;
  readonly query: SearchProductsQuery;
  readonly touchedAtMs: number;
  readonly seen: readonly string[];
  readonly dedupDisabled: boolean;
}

/** Redis-backed in the application; tests supply storage only, never dedup/expiry policy. */
export interface SearchSessionStore {
  read(appId: string, sessionId: string): Promise<SearchSession | null>;
  write(
    appId: string,
    sessionId: string,
    session: SearchSession,
    ttlSeconds: number,
  ): Promise<void>;
}

export interface SearchProductsOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly config: CatalogConfigReader;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
  readonly catalog: Pick<Catalog, 'requirePlatform' | 'resolveProductKey'>;
  readonly cards: CatalogCardEntry;
  readonly upstream: SearchUpstream;
  readonly sessions: SearchSessionStore;
  readonly cursors: SearchCursorCodec;
  readonly newSessionId: () => string;
  readonly logger: Pick<Logger, 'warn'>;
}

/** BR-PRICE-15: price bounds in fen, both ends inclusive. */
const PRICE_MIN_FEN = 1;
const PRICE_MAX_FEN = 10_000_000;
/** Contract Limit parameter: default 20, 1..50. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** BR-PROD-08 ②: a query session expires after 30 minutes without a request. */
export const SEARCH_SESSION_TTL_SECONDS = 1800;
/** BR-PROD-08 ②: at most 500 issued product keys; beyond that the session stops deduplicating. */
export const SEARCH_SEEN_LIMIT = 500;
/** TRADE-20: with no result, the platform's first 10 feed items. */
const FALLBACK_LIMIT = 10;

type SortCode = components['schemas']['SortCode'];

/** The query parameters that define a session (BR-PROD-07 cache parameters without page_no). */
interface SessionQuery {
  readonly platform: Platform;
  readonly q: string;
  readonly sort: SortCode;
  readonly has_coupon: boolean;
  readonly price_min_fen?: number;
  readonly price_max_fen?: number;
  readonly limit: number;
}

function invalid(message: string): never {
  throw new CatalogError(20001, `search: ${message}`);
}

function unavailable(platform: Platform, message: string): never {
  throw new CatalogError(50304, `search: ${message}`, { platform });
}

function priceBound(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < PRICE_MIN_FEN ||
    value > PRICE_MAX_FEN
  ) {
    invalid(`${name} out of range`);
  }
  return value;
}

/** Validates and normalizes the query; any violation is 20001 before any upstream call. */
function normalizeQuery(query: SearchProductsQuery): SessionQuery {
  const min = priceBound(query.price_min_fen, 'price_min_fen');
  const max = priceBound(query.price_max_fen, 'price_max_fen');
  if (min !== undefined && max !== undefined && min > max) invalid('price_min_fen > price_max_fen');
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalid('limit out of range');
  }
  if (typeof query.q !== 'string' || query.q.length === 0) invalid('q is required');
  return {
    platform: query.platform,
    q: query.q,
    sort: query.sort ?? 'relevance',
    has_coupon: query.has_coupon === true,
    ...(min === undefined ? {} : { price_min_fen: min }),
    ...(max === undefined ? {} : { price_max_fen: max }),
    limit,
  };
}

function sameQuery(a: SearchProductsQuery, b: SessionQuery): boolean {
  return (
    a.platform === b.platform &&
    a.q === b.q &&
    a.sort === b.sort &&
    a.has_coupon === b.has_coupon &&
    a.price_min_fen === b.price_min_fen &&
    a.price_max_fen === b.price_max_fen &&
    a.limit === b.limit
  );
}

/** A cursor payload is exactly { search_session_id, page_no }; anything else is 20001. */
function parseCursor(payload: unknown): SearchCursor {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    invalid('malformed cursor');
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'page_no' || keys[1] !== 'search_session_id') {
    invalid('malformed cursor');
  }
  const { search_session_id: id, page_no: pageNo } = payload as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) invalid('malformed cursor');
  if (typeof pageNo !== 'number' || !Number.isSafeInteger(pageNo) || pageNo < 1) {
    invalid('malformed cursor');
  }
  return { search_session_id: id, page_no: pageNo };
}

/** BR-PROD-08 ②: logged-in viewers by user_id, guests by device_id. */
function requesterOf(viewer: Viewer): string {
  if (viewer.userId !== null) return `user:${viewer.userId}`;
  return viewer.deviceId !== null ? `device:${viewer.deviceId}` : 'guest';
}

/**
 * Classifies an error thrown by the union upstream call (after the governed adapter's retries).
 * Business rejections keep their identity: an explicit `invalid_policy` from governance, a
 * UnionError with a business code (invalid DTO/identity, item unavailable, upstream_rejected …),
 * a DemoUnionError, or a CatalogError. Everything else is a dependency failure → 50304, never the
 * pool: governance timeout / circuit_open / quota_exceeded, UnionError upstream_unavailable /
 * rate_limited, and any other throw (network error, unknown error) so it never surfaces as 500.
 */
function isUnionOutage(error: unknown): boolean {
  if (error instanceof GovernanceError) return error.code !== 'invalid_policy';
  if (error instanceof UnionError) {
    return error.code === 'upstream_unavailable' || error.code === 'rate_limited';
  }
  if (error instanceof DemoUnionError || error instanceof CatalogError) return false;
  return true;
}

interface Issued {
  readonly card: ProductCard;
  readonly item: UnionItem;
  /** resolveProductKey of the ref's key; null keys take no part in deduplication. */
  readonly key: string | null;
  /** Upstream (relevance) order across the fetched pages. */
  readonly order: number;
}

/** BR-PROD-08 ①: lowest final price, then highest rebate_max_fen, then earlier position. */
function better(a: Issued, b: Issued): boolean {
  if (a.item.final_price_fen !== b.item.final_price_fen) {
    return a.item.final_price_fen < b.item.final_price_fen;
  }
  const ar = a.card.rebate_max_fen ?? 0;
  const br = b.card.rebate_max_fen ?? 0;
  if (ar !== br) return ar > br;
  return a.order < b.order;
}

function dedupeSamePage(issued: readonly Issued[]): Issued[] {
  const winners = new Map<string, Issued>();
  for (const entry of issued) {
    if (entry.key === null) continue;
    const current = winners.get(entry.key);
    if (current === undefined || better(entry, current)) winners.set(entry.key, entry);
  }
  return issued.filter((entry) => entry.key === null || winners.get(entry.key) === entry);
}

/** TRADE-20: price and rebate sorts reorder only this response; ties keep upstream order. */
function sortPage(issued: Issued[], sort: SortCode): Issued[] {
  const byOrder = (a: Issued, b: Issued): number => a.order - b.order;
  if (sort === 'final_price_asc') {
    return issued.sort((a, b) =>
      a.item.final_price_fen === b.item.final_price_fen
        ? byOrder(a, b)
        : a.item.final_price_fen < b.item.final_price_fen
          ? -1
          : 1,
    );
  }
  if (sort === 'rebate_desc') {
    return issued.sort((a, b) => {
      const am = a.card.rebate_min_fen ?? 0;
      const bm = b.card.rebate_min_fen ?? 0;
      return am === bm ? byOrder(a, b) : bm - am;
    });
  }
  return issued.sort(byOrder);
}

/**
 * BR-PROD-07/08/10, BR-PRICE-08/15 and the B1-05d brief. Return the contract data body;
 * failures expose code and data for the HTTP envelope. Missing query PID defaults to 50304
 * plus an alert, as the task's replaceable policy pending owner confirmation specifies.
 *
 * Order: query validation (20001) → platform capability (30131) → search switch (50304
 * search_disabled, re-read every request) → cursor (20001) → session → query PID → upstream page,
 * at most one refill page → per-candidate filtering through the single card entry → same-page
 * dedupe → page sort → slice → session write → fallback feed on an empty first page.
 */
export async function searchProducts(
  query: SearchProductsQuery,
  options: SearchProductsOptions,
): Promise<SearchProductsData> {
  const { clock, config, catalog, cards, upstream, sessions, cursors, logger } = options;
  const normalized = normalizeQuery(query);
  const { platform, limit } = normalized;

  const viewer = await options.viewerContext.current();
  const { appId } = viewer;
  await catalog.requirePlatform(platform, { parseEnabled: false, searchEnabled: true });

  // BR-PROD-10 细则: only a boolean true opens search; anything else is off.
  const switchEntry = await config.configValue(appId, `search.enabled.${platform}`);
  if (switchEntry?.value !== true) {
    throw new CatalogError(50304, 'search: platform search switch is off', {
      platform,
      reason: 'search_disabled',
    });
  }

  const claims = query.cursor === undefined ? null : parseCursor(cursors.decode(query.cursor));
  const nowMs = clock.now().getTime();
  const requester = requesterOf(viewer);

  // A continuation needs a live session of the same requester and the same query; anything else
  // (expired, cleared, foreign, changed filters or sort) starts a new session from page 1.
  let sessionId: string | null = null;
  let session: SearchSession | null = null;
  if (claims !== null) {
    const stored = await sessions.read(appId, claims.search_session_id);
    if (
      stored !== null &&
      stored.appId === appId &&
      stored.requester === requester &&
      nowMs - stored.touchedAtMs <= SEARCH_SESSION_TTL_SECONDS * 1000 &&
      sameQuery(stored.query, normalized)
    ) {
      sessionId = claims.search_session_id;
      session = stored;
    }
  }
  const firstPage = session === null;
  const startPage = session === null ? 1 : claims!.page_no;
  if (sessionId === null) sessionId = options.newSessionId();
  const seen = new Set(session?.seen ?? []);
  let dedupDisabled = session?.dedupDisabled ?? false;

  // BR-PROD-07: fixed query-only promotion slot, no relation_id; missing → 50304 + alert.
  const pid = await options.pids.getActivePid({
    appId,
    platform,
    pidScene: 'query',
    purpose: 'query',
  });
  if (pid === null) {
    logger.warn(
      { event: 'search_query_pid_missing', platform },
      'search: no active query promotion slot, treated as union unavailable',
    );
    unavailable(platform, 'no active query promotion slot');
  }

  const request = (pageNo: number): SearchUpstreamRequest => ({
    appId,
    platform,
    keyword: normalized.q,
    pageNo,
    pageSize: limit,
    sort: normalized.sort === 'sales_desc' ? 'sales_desc' : 'relevance',
    ...(normalized.has_coupon ? { hasCoupon: true } : {}),
    ...(normalized.price_min_fen === undefined ? {} : { priceMinFen: normalized.price_min_fen }),
    promotionSlot: pid.pid,
  });

  const issued: Issued[] = [];
  let order = 0;
  const take = async (candidates: readonly SearchCandidate[]): Promise<void> => {
    for (const { item, ref } of candidates) {
      const position = order++;
      // Anomalies go to the card entry, which logs PRICE_ANOMALY and skips them before any price
      // filter, quote or link registration (B1-05i).
      if (isPriceAnomaly(item)) {
        await cards.assemble({
          item,
          ref,
          entrySource: 'search',
          stale: false,
          scene: 'retrieval',
        });
        continue;
      }
      const final = item.final_price_fen;
      if (normalized.price_min_fen !== undefined && final < BigInt(normalized.price_min_fen)) {
        continue;
      }
      if (normalized.price_max_fen !== undefined && final > BigInt(normalized.price_max_fen)) {
        continue;
      }
      if (normalized.has_coupon && item.coupon_fen <= 0n) continue;
      const key = ref.productKey === null ? null : await catalog.resolveProductKey(ref.productKey);
      if (key !== null && !dedupDisabled && seen.has(key)) continue;
      const result = await cards.assemble({
        item,
        ref,
        entrySource: 'search',
        stale: false,
        scene: 'retrieval',
      });
      if (result.kind !== 'card') continue;
      // BR-PRICE-08: search never shows no_rebate cards.
      if (result.card.rebate_basis === 'no_rebate') continue;
      issued.push({ card: result.card, item, key, order: position });
    }
  };

  let page: SearchUpstreamPage;
  try {
    page = await upstream.search(request(startPage));
  } catch (error: unknown) {
    if (isUnionOutage(error)) unavailable(platform, 'union search unavailable');
    throw error;
  }
  let lastPage = startPage;
  let hasMore = page.hasMore;
  await take(page.items);

  // BR-PRICE-08: at most one refill page; has_more follows the last upstream page.
  if (dedupeSamePage(issued).length < limit && page.hasMore) {
    let refill: SearchUpstreamPage | null = null;
    try {
      refill = await upstream.search(request(startPage + 1));
    } catch (error: unknown) {
      if (!isUnionOutage(error)) throw error;
      // A refill outage must not pass for "no result": with nothing deliverable from the first
      // page this is the same 50304 { platform } as a first-page outage (no fallback feed);
      // otherwise degrade to the first page's cards and its upstream has_more, with an alert.
      if (dedupeSamePage(issued).length === 0) {
        unavailable(platform, 'union search unavailable on the refill page');
      }
      logger.warn(
        { event: 'search_refill_unavailable', platform },
        'search: refill page unavailable, returning the first page only',
      );
    }
    if (refill !== null) {
      lastPage = startPage + 1;
      hasMore = refill.hasMore;
      await take(refill.items);
    }
  }

  const delivered = sortPage(dedupeSamePage(issued), normalized.sort).slice(0, limit);

  // BR-PROD-08 ②: only issued keys enter the seen set; beyond 500 the session stops deduping,
  // keeping the older keys and dropping the new ones.
  const seenList = [...seen];
  for (const entry of delivered) {
    if (entry.key === null || seen.has(entry.key)) continue;
    if (seenList.length >= SEARCH_SEEN_LIMIT) {
      dedupDisabled = true;
      continue;
    }
    seen.add(entry.key);
    seenList.push(entry.key);
  }
  await sessions.write(
    appId,
    sessionId,
    {
      appId,
      requester,
      query: normalized,
      touchedAtMs: nowMs,
      seen: seenList,
      dedupDisabled,
    },
    SEARCH_SESSION_TTL_SECONDS,
  );

  const items = delivered.map((entry) => entry.card);
  const fallbackItems =
    firstPage && items.length === 0 ? await fallback(platform, appId, pid.pid, options) : [];

  return {
    items,
    next_cursor: hasMore
      ? cursors.encode({ search_session_id: sessionId, page_no: lastPage + 1 })
      : null,
    has_more: hasMore,
    fallback_items: fallbackItems,
  };
}

/**
 * TRADE-20: an empty first page shows the platform's first 10 feed items from the selectable
 * whitelisted channel (CT-15m; an empty whitelist gives an empty list). Search filters do not
 * apply; anomalies and no_rebate items are still dropped through the single card entry.
 */
async function fallback(
  platform: Platform,
  appId: string,
  promotionSlot: string,
  options: SearchProductsOptions,
): Promise<ProductCard[]> {
  const channel = getMaterialChannels().channels.find(
    (entry) => entry.platform === platform && entry.selectable === true,
  );
  if (channel === undefined) return [];
  let page: SearchUpstreamPage;
  try {
    page = await options.upstream.materialFeed({
      appId,
      platform,
      channelId: channel.channel_id,
      limit: FALLBACK_LIMIT,
      promotionSlot,
    });
  } catch (error: unknown) {
    if (!isUnionOutage(error)) throw error;
    options.logger.warn(
      { event: 'search_fallback_unavailable', platform },
      'search: fallback feed unavailable',
    );
    return [];
  }
  const cardsOut: ProductCard[] = [];
  const keys = new Set<string>();
  for (const { item, ref } of page.items) {
    if (cardsOut.length >= FALLBACK_LIMIT) break;
    const key =
      isPriceAnomaly(item) || ref.productKey === null
        ? null
        : await options.catalog.resolveProductKey(ref.productKey);
    if (key !== null && keys.has(key)) continue;
    const result = await options.cards.assemble({
      item,
      ref,
      entrySource: 'search',
      stale: false,
      scene: 'retrieval',
    });
    if (result.kind !== 'card' || result.card.rebate_basis === 'no_rebate') continue;
    if (key !== null) keys.add(key);
    cardsOut.push(result.card);
  }
  return cardsOut;
}
