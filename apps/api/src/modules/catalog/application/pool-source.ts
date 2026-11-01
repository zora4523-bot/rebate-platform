// B1-05q: where a product pool gets a product from. Three entries: a link or token (parsing's
// resolution, through the PoolLinkParser port app.module assembles, so catalog never imports
// parsing), a union pick's item_ref, and the re-check of an item already in a pool. Each answers
// with the one key the pool stores (alias-resolved, BR-PROD-08 ③) and the union's answer of this
// call: live, off shelf, or not passed. Not passed keeps the refusal a new key gets, because only
// the transaction knows whether the key is in the pool; what the union cannot answer now and what
// names no product stay CatalogError.
import { randomUUID } from 'node:crypto';
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import type { Clock } from '../../platform/index.ts';
import {
  UnionError,
  isRegisteredPlatform,
  type CallCtx,
  type ItemRef,
  type Platform,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionItem,
  type UnionItemDetail,
} from '../../union/index.ts';
import { detailRawItemId, upstreamFailure, type ProductDetailUpstream } from '../detail.ts';
import { CatalogError } from '../domain/rules.ts';
import type {
  Catalog,
  ProductCapabilities,
  ProductIdentity,
  ProductRef,
  RequestRawRef,
  ReparseResult,
} from '../domain/types.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';
import type { ItemRefService } from './item-ref.ts';

/** One link or token of the operator's text, in parsing's own extraction. */
export interface PoolLinkCandidate {
  readonly kind: 'url' | 'tpwd';
  readonly raw: string;
}

/** Union calls of one resolution, wrapped by this file so a known key survives a refused detail. */
export type PoolLinkAdapters = (
  platform: RegisteredPlatform,
) => Pick<UnionAdapter, 'resolveLink' | 'getItem'>;

/** Parsing's refusal codes arrive as numbers: 30131, 30132, 30141, 50301 (a dependency failure). */
export type PoolLinkAnswer =
  | { readonly ok: true; readonly item: UnionItemDetail; readonly ref: ProductRef }
  | { readonly ok: false; readonly code: number };

/** parseUrl / parseToken and extractCandidates, assembled by app.module. */
export interface PoolLinkParser {
  candidates(text: string): readonly PoolLinkCandidate[];
  parse(
    candidate: PoolLinkCandidate,
    adapters: PoolLinkAdapters,
    context: CallCtx,
  ): Promise<PoolLinkAnswer>;
}

export type PoolProduct =
  | {
      readonly kind: 'live';
      readonly productKey: string;
      readonly platform: Platform;
      readonly rawItemId: string;
      readonly item: UnionItemDetail;
    }
  | { readonly kind: 'off_shelf'; readonly productKey: string }
  | {
      readonly kind: 'not_passed';
      readonly productKey: string;
      readonly failure: PoolRecheckFailure;
      /** The answer when the key is new; a key in the pool takes the failure as its reason. */
      readonly refusal: CatalogError;
    };

/** The union answered and the item fails: its reference no longer leads here, or a flagged price. */
export type PoolRecheckFailure = 'ref_expired' | 'price_anomaly';

/** What a re-check of a stored item needs: its key, and the raw ID and time it holds. */
export interface PoolStoredProduct {
  readonly appId: string;
  readonly platform: Platform;
  readonly productKey: string;
  readonly rawItemId: string;
  /** When its raw ID was obtained, at the latest (poolRawFetchedMs). */
  readonly fetchedAt: string;
  readonly title: string;
}

export interface PoolSource {
  fromLink(appId: string, text: string): Promise<PoolProduct>;
  fromItemRef(appId: string, itemRef: string): Promise<PoolProduct>;
  recheck(stored: PoolStoredProduct): Promise<PoolProduct>;
  /** B1-05r: the refresh's read; the row's raw ID is no source, so it starts at product_refs. */
  current(stored: Omit<PoolStoredProduct, 'rawItemId' | 'fetchedAt'>): Promise<PoolProduct>;
}

export interface PoolSourceOptions {
  readonly clock: Clock;
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
  readonly catalog: Pick<
    Catalog,
    'listPlatforms' | 'resolveProductKey' | 'readProductRef' | 'takeRawItemId'
  >;
  readonly itemRefs: Pick<ItemRefService, 'read'>;
  readonly union: GovernedUnion;
  /** Uncached: a pool add and a re-check read the union itself (createUnionDetailUpstream). */
  readonly upstream: ProductDetailUpstream;
  readonly links: PoolLinkParser;
  /** Quota purpose of every union call made here; `online` unless the caller names another. */
  readonly purpose?: CallCtx['purpose'];
}

/** Thrown when one `link_text` holds more than one product (20001 data.fields=[link_text]). */
export class PoolManyProductsError extends Error {
  constructor() {
    super('catalog: link_text holds more than one product');
    this.name = 'PoolManyProductsError';
  }
}

const JD_MODE = 'product_key.jd.mode';
/** BR-PROD-10: a pool add does not depend on the keyword search switch, as the detail route. */
const POOL_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: true,
  searchEnabled: false,
});
/** BR-PROD-05 重新解析步骤 2: the title search reads the platform's first page, ≤ 20 rows. */
const REPARSE_SEARCH_ROWS = 20;
const PARSE_UNDERIVABLE = 30131;
const PARSE_UNRECOGNIZED = 30132;
const PARSE_OFF_SHELF = 30141;
const PARSE_DEPENDENCY_DOWN = 50301;

function unavailable(message: string): CatalogError {
  return new CatalogError(50401, `pool: ${message}`);
}

/** What the title search of BR-PROD-05 重新解析步骤 2 looks for, and on which call context. */
export interface TitleSearch {
  readonly adapter: Pick<UnionAdapter, 'searchItems'>;
  readonly platform: Platform;
  readonly title: string;
  readonly jdMode: string;
  readonly context: CallCtx;
  readonly isTarget: (item: UnionItem) => boolean | Promise<boolean>;
}

/** BR-PROD-05 重新解析步骤 2; null when no item of the key can be found by title (引用失效). */
export async function searchRawByTitle(
  search: TitleSearch,
): Promise<{ readonly raw: string; readonly item: UnionItem } | null> {
  const { adapter, platform, title, jdMode, context, isTarget } = search;
  let page: Awaited<ReturnType<UnionAdapter['searchItems']>>;
  try {
    page = await adapter.searchItems({ keyword: title }, context);
  } catch (error: unknown) {
    // A platform that has no title search answers like a page without the key; it is no outage.
    if (error instanceof UnionError && error.code === 'adapter_unimplemented') return null;
    throw error;
  }
  for (const item of page.items.slice(0, REPARSE_SEARCH_ROWS)) {
    if (item.platform !== platform) continue;
    const raw = detailRawItemId(item, jdMode);
    if (raw !== undefined && (await isTarget(item))) return { raw, item };
  }
  return null;
}

function refExpired(productKey: string, refusal: CatalogError): PoolProduct {
  return { kind: 'not_passed', productKey, failure: 'ref_expired', refusal };
}

function anotherProduct(productKey: string): PoolProduct {
  return refExpired(
    productKey,
    new CatalogError(30143, 'pool: the union answered another product'),
  );
}

/** The union side of adminAddPoolItem and adminUpdatePoolItem. */
export function createPoolSource(options: PoolSourceOptions): PoolSource {
  const { clock, config, catalog, itemRefs, union, upstream, links, purpose = 'online' } = options;

  function context(appId: string): CallCtx {
    return { appId, requestId: randomUUID(), purpose };
  }

  async function jdModeOf(appId: string, platform: Platform): Promise<string> {
    if (platform !== 'jd') return 'item';
    const entry = await config.configValue(appId, JD_MODE);
    // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
    return entry === null ? 'item' : String(entry.value);
  }

  /** The single derivation (BR-PROD-03), alias-resolved; null when the key cannot be derived. */
  async function keyOf(ref: ItemRef, jdMode: string): Promise<string | null> {
    const row = (await catalog.listPlatforms()).find((entry) => entry.code === ref.platform);
    try {
      const derived = deriveProductKey(
        {
          platform: ref.platform,
          keyPrefix: row?.key_prefix ?? null,
          ...(ref.platform === 'jd' ? { jdMode: jdMode as 'item' | 'sku' } : {}),
        },
        ref,
      );
      return await catalog.resolveProductKey(derived);
    } catch (error: unknown) {
      if (error instanceof ProductKeyUnderivable) return null;
      throw error;
    }
  }

  function foundRef(
    identity: ProductIdentity,
    stored: ProductRef | null,
    title: string,
    rawItemId: string,
    rawFetchedAt: string,
  ): ReparseResult {
    return {
      kind: 'found',
      ref: {
        appId: identity.appId,
        platform: identity.platform,
        productKey: identity.productKey!,
        rawItemId,
        rawFetchedAt,
        receivedAt: clock.now().toISOString(),
        canonicalUrl: stored?.canonicalUrl ?? null,
        title,
        shopId: stored?.shopId ?? null,
        shopType: stored?.shopType ?? null,
        source: 'pool',
      },
    };
  }

  /** BR-PROD-05 重新解析步骤 1. The URL is product_refs' own canonical one, never user text. */
  async function reparseByUrl(
    identity: ProductIdentity,
    adapter: UnionAdapter,
    stored: ProductRef,
    url: string,
    jdMode: string,
  ): Promise<ReparseResult> {
    const { item } = await adapter.resolveLink(url, context(identity.appId));
    const raw = detailRawItemId(item, jdMode);
    if (raw === undefined || (await keyOf(item, jdMode)) !== identity.productKey) {
      return { kind: 'ref_expired' };
    }
    return foundRef(identity, stored, stored.title, raw, clock.now().toISOString());
  }

  /** BR-PROD-05 重新解析步骤 2. */
  async function reparseByTitle(
    identity: ProductIdentity,
    adapter: UnionAdapter,
    stored: ProductRef | null,
    title: string,
    jdMode: string,
  ): Promise<ReparseResult> {
    const found = await searchRawByTitle({
      adapter,
      platform: identity.platform,
      title,
      jdMode,
      context: context(identity.appId),
      isTarget: async (item) => (await keyOf(item, jdMode)) === identity.productKey,
    });
    if (found === null) return { kind: 'ref_expired' };
    return foundRef(identity, stored, title, found.raw, found.item.quoted_at);
  }

  async function reparse(
    identity: ProductIdentity,
    platform: RegisteredPlatform,
    titleHint: string | null,
    jdMode: string,
  ): Promise<ReparseResult> {
    const stored = await catalog.readProductRef(identity);
    const title = stored?.title ?? titleHint;
    const adapter = union.adapter(platform);
    try {
      if (stored !== null && stored.canonicalUrl !== null) {
        return await reparseByUrl(identity, adapter, stored, stored.canonicalUrl, jdMode);
      }
      if (title === null) return { kind: 'ref_expired' };
      return await reparseByTitle(identity, adapter, stored, title, jdMode);
    } catch (error: unknown) {
      const mapped = upstreamFailure(error);
      if (!(mapped instanceof CatalogError)) throw mapped;
      if (mapped.code === 30141) return { kind: 'off_shelf' };
      if (mapped.code === 30143) return { kind: 'ref_expired' };
      if (mapped.code === 50401) return { kind: 'temporary_failure' };
      throw mapped;
    }
  }

  /** BR-PROD-05 order for a known key, then one uncached union detail; only a fresh raw ID asks. */
  async function byKey(
    appId: string,
    platform: Platform,
    productKey: string,
    requestRef: RequestRawRef | null,
    titleHint: string | null,
  ): Promise<PoolProduct> {
    if (!isRegisteredPlatform(platform)) {
      return refExpired(productKey, new CatalogError(30131, 'pool: platform has no union adapter'));
    }
    const jdMode = await jdModeOf(appId, platform);
    let rawItemId: string;
    let item: UnionItemDetail;
    try {
      ({ rawItemId } = await catalog.takeRawItemId({
        appId,
        platform,
        productKey,
        requestRef,
        fallbackEnabled: false,
        capabilities: POOL_CAPABILITIES,
        reparse: (identity) => reparse(identity, platform, titleHint, jdMode),
      }));
      item = await upstream.detail({
        appId,
        productKey,
        platform,
        ...(platform === 'jd' ? { jdMode } : {}),
        rawItemId,
      });
    } catch (error: unknown) {
      const mapped = upstreamFailure(error);
      if (mapped instanceof CatalogError && mapped.code === 30141) {
        return { kind: 'off_shelf', productKey };
      }
      if (mapped instanceof CatalogError && mapped.code === 30143) {
        return refExpired(productKey, mapped);
      }
      throw mapped;
    }
    if (item.platform !== platform) return anotherProduct(productKey);
    const derived = await keyOf(item, jdMode);
    if (derived === null) {
      return refExpired(productKey, new CatalogError(30131, 'pool: key not derivable'));
    }
    if (derived !== productKey) return anotherProduct(productKey);
    return live(productKey, platform, detailRawItemId(item, jdMode) ?? rawItemId, item);
  }

  /**
   * A price the union itself flags cannot be stored as the pool's price; the union has answered,
   * so a retry changes nothing and only a new key is refused with the 50401 of a missing quote.
   * The BR-PRICE-01 field checks stay on the read side: the pool is read through the card entry.
   */
  function live(
    productKey: string,
    platform: Platform,
    rawItemId: string,
    item: UnionItemDetail,
  ): PoolProduct {
    if (item.price_status === 'anomaly') {
      return {
        kind: 'not_passed',
        productKey,
        failure: 'price_anomaly',
        refusal: unavailable('the union flags this price'),
      };
    }
    return { kind: 'live', productKey, platform, rawItemId, item };
  }

  /** One candidate: the product, or the refusal's code. */
  async function fromCandidate(
    appId: string,
    candidate: PoolLinkCandidate,
  ): Promise<PoolProduct | number> {
    // parseUrl and parseToken drop the key when the detail refuses, and a known key still decides
    // what happens to the pool's items, so the reference the detail is asked with is kept here.
    let asked: ItemRef | null = null;
    const adapters: PoolLinkAdapters = (platform) => {
      const adapter = union.adapter(platform);
      return {
        resolveLink: (raw, ctx) => adapter.resolveLink(raw, ctx),
        getItem: (ref, ctx) => {
          asked = ref;
          return adapter.getItem(ref, ctx);
        },
      };
    };
    const answer = await links.parse(candidate, adapters, context(appId));
    if (answer.ok) {
      const { item, ref } = answer;
      const productKey = await catalog.resolveProductKey(ref.productKey);
      if (item.platform !== ref.platform) return anotherProduct(productKey);
      // A detail may omit the IDs (parsing then keeps the reference's), which says no other product.
      const derived = await keyOf(item, await jdModeOf(appId, ref.platform));
      if (derived !== null && derived !== productKey) return anotherProduct(productKey);
      return live(productKey, ref.platform, ref.rawItemId, item);
    }
    const ref = asked as ItemRef | null;
    const productKey = ref === null ? null : await keyOf(ref, await jdModeOf(appId, ref.platform));
    if (productKey === null) return answer.code;
    if (answer.code === PARSE_OFF_SHELF) return { kind: 'off_shelf', productKey };
    if (answer.code === PARSE_UNDERIVABLE || answer.code === PARSE_UNRECOGNIZED) {
      return refExpired(productKey, new CatalogError(answer.code, 'pool: detail refused'));
    }
    return answer.code;
  }

  return {
    /**
     * Resolved as parseInput resolves it: at most three candidates, in text order, one product per
     * key. A candidate that is no product does not stop the others; one the union could not answer
     * might be a second product, so that is 50401, retry.
     */
    async fromLink(appId, text) {
      const candidates = links.candidates(text);
      if (candidates.length === 0) throw new CatalogError(30132, 'pool: nothing recognisable');
      const products = new Map<string, PoolProduct>();
      const refusals: number[] = [];
      for (const candidate of candidates) {
        const result = await fromCandidate(appId, candidate);
        if (typeof result === 'number') refusals.push(result);
        else if (!products.has(result.productKey)) products.set(result.productKey, result);
      }
      if (products.size > 1) throw new PoolManyProductsError();
      if (refusals.includes(PARSE_DEPENDENCY_DOWN)) throw unavailable('link not resolved now');
      const [product] = products.values();
      if (product !== undefined) return product;
      throw new CatalogError(refusals[0] as 30131 | 30132 | 30141, 'pool: link refused');
    },

    /** A token that does not open, or is another app's, names nothing here: 30132. */
    async fromItemRef(appId, itemRef) {
      const token = itemRefs.read(itemRef, appId);
      if (token === null) throw new CatalogError(30132, 'pool: item_ref not usable');
      const productKey = await catalog.resolveProductKey(token.productKey);
      return byKey(appId, token.platform, productKey, token, null);
    },

    async recheck(stored) {
      const { appId, platform, rawItemId, fetchedAt, title } = stored;
      // An alias added after the item was stored still compares as the same product (BR-PROD-08).
      const productKey = await catalog.resolveProductKey(stored.productKey);
      const held: RequestRawRef = {
        appId,
        platform,
        productKey,
        rawItemId,
        fetchedAt,
        source: 'link',
      };
      return byKey(appId, platform, productKey, held, title);
    },

    async current({ appId, platform, productKey, title }) {
      const resolved = await catalog.resolveProductKey(productKey);
      return byKey(appId, platform, resolved, null, title);
    },
  };
}
