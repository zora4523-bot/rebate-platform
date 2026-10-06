// B1-05d public search use case. Tests call this file directly; no forwarding-only entry.
// The HTTP controller will supply contract-validated query parameters and server-owned ports.
import type { components, operations } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { Clock } from '../platform/index.ts';
import type { Platform, UnionItem, UnionPidService } from '../union/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import type { Catalog, ProductRef } from './domain/types.ts';
import type { CatalogConfigReader, ViewerContext } from './ports.ts';

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

/**
 * BR-PROD-07/08/10, BR-PRICE-08/15 and the B1-05d brief. Return the contract data body;
 * failures expose code and data for the HTTP envelope. Missing query PID defaults to 50304
 * plus an alert, as the task's replaceable policy pending owner confirmation specifies.
 */
export async function searchProducts(
  query: SearchProductsQuery,
  options: SearchProductsOptions,
): Promise<SearchProductsData> {
  void query;
  void options;
  throw new Error('NotImplemented: searchProducts');
}
