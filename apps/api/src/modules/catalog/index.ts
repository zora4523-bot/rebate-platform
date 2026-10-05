import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';
import type { Platform, UnionItem } from '../union/index.ts';

export interface ProductIdentity {
  readonly appId: string;
  readonly platform: Platform;
  readonly productKey: string | null;
}

export interface PlatformRecord {
  readonly code: string;
  readonly key_prefix: string | null;
  readonly key_stability: 'unverified' | 'stable_24h' | 'stable_7d' | 'unstable';
  readonly search_support: string;
  readonly convert_support: string;
  readonly order_sync_support: string;
  readonly stage: string;
}

/** Runtime capabilities, already resolved by the calling use case; not dictionary marks. */
export interface ProductCapabilities {
  readonly parseEnabled: boolean;
  readonly searchEnabled: boolean;
}

export interface ProductRef extends ProductIdentity {
  readonly productKey: string;
  readonly rawItemId: string;
  readonly rawFetchedAt: string;
  /** The response receipt instant, captured with Clock before queuing the write. */
  readonly receivedAt: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly shopId: string | null;
  readonly shopType: string | null;
  readonly source: 'search' | 'detail' | 'parse' | 'pool';
}

/** A trusted, decoded item_ref or a server-read links row; wire verification is B1-05h. */
export interface RequestRawRef extends ProductIdentity {
  readonly productKey: string;
  readonly rawItemId: string;
  readonly fetchedAt: string;
  readonly source: 'item_ref' | 'link';
}

export type ReparseResult =
  | { readonly kind: 'found'; readonly ref: ProductRef }
  | { readonly kind: 'off_shelf' | 'ref_expired' | 'temporary_failure' };

export interface RawItemRequest extends ProductIdentity {
  readonly productKey: string;
  readonly requestRef: RequestRawRef | null;
  /** Server policy only. This module does not enable or derive fallback keys. */
  readonly fallbackEnabled: boolean;
  readonly capabilities: ProductCapabilities;
  readonly reparse: (identity: ProductIdentity) => Promise<ReparseResult>;
}

export interface RawItemResult {
  readonly rawItemId: string;
  readonly source: 'item_ref' | 'link' | 'product_refs' | 'reparse';
}

export interface CategoryCandidate {
  readonly platform: Platform;
  readonly categoryId: string;
  readonly title: string;
}

export interface Catalog {
  listPlatforms(): Promise<readonly PlatformRecord[]>;
  requirePlatform(code: string, capabilities: ProductCapabilities): Promise<PlatformRecord>;
  resolveProductKey(key: string): Promise<string>;
  isSameProduct(left: ProductIdentity, right: ProductIdentity): Promise<boolean>;
  registerProductRef(ref: ProductRef, capabilities: ProductCapabilities): Promise<void>;
  readProductRef(identity: ProductIdentity): Promise<ProductRef | null>;
  takeRawItemId(request: RawItemRequest): Promise<RawItemResult>;
  filterCategories<T extends CategoryCandidate>(appId: string, items: readonly T[]): Promise<T[]>;
}

export interface CatalogOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** Cyclic/overlong alias chains are observable without logging raw upstream IDs. */
  readonly warn: (event: {
    readonly kind: 'alias_cycle' | 'alias_limit';
    readonly key: string;
  }) => void;
}

export function createCatalog(options: CatalogOptions): Catalog {
  void options;
  throw new Error('NotImplemented: createCatalog');
}

export interface Viewer {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

/** These five class values are DI tokens; linking/quotation providers arrive in later tasks. */
export class ViewerContext {
  current(): Promise<Viewer> {
    throw new Error('NotImplemented: ViewerContext.current');
  }
}

export function createGuestViewerContext(scope: {
  readonly appId: string;
  readonly deviceId: string | null;
}): ViewerContext {
  void scope;
  throw new Error('NotImplemented: createGuestViewerContext');
}

export interface RebateQuote {
  readonly rebateMinFen: bigint | null;
  readonly rebateMaxFen: bigint | null;
  readonly estNetPriceFen: bigint | null;
  readonly rebateBasis: components['schemas']['ProductCard']['rebate_basis'];
}

export class RebateQuoter {
  quote(item: UnionItem, viewer: Viewer): Promise<RebateQuote> {
    void item;
    void viewer;
    throw new Error('NotImplemented: RebateQuoter.quote');
  }
}

export interface RegisterLinkInput {
  readonly viewer: Viewer;
  readonly ref: ProductRef;
  readonly item: UnionItem;
  readonly quote: RebateQuote;
  /** Opaque value read from the originating link, not a newly invented enumeration. */
  readonly entrySource: string | null;
}

export class LinkRegistrar {
  register(input: RegisterLinkInput): Promise<{ readonly linkId: string }> {
    void input;
    throw new Error('NotImplemented: LinkRegistrar.register');
  }
}

export class SourceLinkReader {
  entrySource(appId: string, linkId: string): Promise<string | null> {
    void appId;
    void linkId;
    throw new Error('NotImplemented: SourceLinkReader.entrySource');
  }
}

/** Structurally matches content's public read port; assembly is owned by app.module.ts. */
export class CatalogConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: DB['config_items']['value']; readonly version: number } | null> {
    void appId;
    void key;
    throw new Error('NotImplemented: CatalogConfigReader.configValue');
  }
}
