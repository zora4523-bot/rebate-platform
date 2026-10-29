// B1-28h public hot-sales list use case, GET /v1/rank/hot (contract getHotRank, CT-22c; 规划/01
// F-PROD-13; BR-TEXT-13, BR-TEXT-17 细则「联盟物料频道」). Rule tests: test/spec/catalog/hot-rank/**.
import type { components, operations } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { Clock, MaterialChannelsSpec } from '../platform/index.ts';
import type { Platform, UnionItem } from '../union/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import type { ProductRef } from './domain/types.ts';
import type { ViewerContext } from './ports.ts';

export type HotRankQuery = operations['getHotRank']['parameters']['query'];
export type HotRankData = components['schemas']['HotRankData'];

/** One category the channel offers, as the union side reports it. */
export interface HotRankCategoryEntry {
  readonly categoryId: string;
  readonly name: string;
}

/** One channel position: the normalized union item, its ref and the union's sales field as is. */
export interface HotRankCandidate {
  readonly item: UnionItem;
  readonly ref: ProductRef;
  /** The union's sales field unchanged; null when the union gives none. */
  readonly salesText: string | null;
}

export interface HotRankCategoriesRequest {
  readonly appId: string;
  readonly platform: Platform;
  readonly channelId: string;
}

export interface HotRankPageRequest extends HotRankCategoriesRequest {
  /** null for the whole list. */
  readonly categoryId: string | null;
  /** From 1. */
  readonly pageNo: number;
  readonly pageSize: number;
}

/** One channel page, in the channel's own order. */
export interface HotRankUpstreamPage {
  readonly items: readonly HotRankCandidate[];
  readonly hasMore: boolean;
}

/** Union seam of the hot list: one whitelisted channel, never the product pool. */
export interface HotRankUpstream {
  categories(input: HotRankCategoriesRequest): Promise<readonly HotRankCategoryEntry[]>;
  page(input: HotRankPageRequest): Promise<HotRankUpstreamPage>;
}

export interface HotRankOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly cards: CatalogCardEntry;
  /** Read before every fetch (production: platform's getMaterialChannels). */
  readonly channels: () => MaterialChannelsSpec;
  /** The cached union side (infra/hot-rank-cache.ts in production). */
  readonly upstream: HotRankUpstream;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * One page of the hot-sales list of a platform: a selectable whitelisted channel checked before
 * every fetch (none → 50304 rank_unavailable), its categories, items in channel order with rank
 * counted from 1 across pages, sales_text passed through, cards registering a link and quote
 * snapshot only; a union failure without a usable cache is 50304 without reason; a category not
 * offered or a malformed / foreign cursor is 20001.
 */
export function getHotRank(query: HotRankQuery, options: HotRankOptions): Promise<HotRankData> {
  void query;
  void options;
  throw new Error('NotImplemented: getHotRank');
}
