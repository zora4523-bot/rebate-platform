// B1-05e: GET /v1/products/{product_key}, the product detail use case. Tests call this file
// directly; the HTTP controller (http/public/product.controller.ts) supplies the
// contract-validated path and query plus the server-owned ports.
import type { components } from '@couli/contracts-ts';
import {
  ProductKeyInvalid,
  ProductKeyUnderivable,
  deriveProductKey,
  splitProductKey,
} from '@couli/domain';
import { GovernanceError, type Clock } from '../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isRegisteredPlatform,
  type RegisteredPlatform,
  type UnionItemDetail,
} from '../union/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import type { ItemRefService } from './application/item-ref.ts';
import { CatalogError, isFresh } from './domain/rules.ts';
import type { Catalog, ProductCapabilities, ProductRef, RequestRawRef } from './domain/types.ts';
import type { CatalogConfigReader, ViewerContext } from './ports.ts';

export interface ProductDetailQuery {
  readonly product_key: string;
  readonly item_ref?: string;
  /** Server-read source link; never trust a client-supplied entry_source. */
  readonly from_link_id?: string;
}

export interface ProductDetailRequest {
  readonly appId: string;
  readonly productKey: string;
  /** Platform of the requested key's prefix (platforms.key_prefix). */
  readonly platform?: RegisteredPlatform;
  /** product_key.jd.mode of the app, only for jd: which raw ID field rawItemId fills. */
  readonly jdMode?: string;
  /** Absent means re-resolve the product key, never fabricate an upstream raw ID. */
  readonly rawItemId?: string;
  /**
   * The detail use case's resolved raw ID (item_ref or product_refs) must be the one the union is
   * asked with: a detail cache entry fetched under another raw ID of the same product_key counts
   * as a miss and is overwritten (AC-B1-05k#5/#7). Display reads leave it unset and share the
   * entry by product_key alone (BR-PROD-07).
   */
  readonly requireRawMatch?: boolean;
}

/**
 * Union answers a cache served from an entry past its hit window because the union was down
 * (BR-PROD-07 熔断降级, BR-PRICE-11): the card is stale=true with the entry's quoted_at.
 */
const STALE_DETAILS = new WeakSet<object>();

/** Marks a detail answer as a stale cache entry (infra/product-cache.ts). */
export function markStaleDetail<T extends UnionItemDetail>(item: T): T {
  STALE_DETAILS.add(item);
  return item;
}

export interface ProductDetailUpstream {
  detail(request: ProductDetailRequest): Promise<UnionItemDetail>;
}

export interface ProductDetailOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly config: CatalogConfigReader;
  readonly catalog: Pick<Catalog, 'listPlatforms' | 'readProductRef' | 'registerProductRef'>;
  readonly itemRefs: ItemRefService;
  readonly cards: CatalogCardEntry;
  readonly upstream: ProductDetailUpstream;
}

export type ProductDetailData = components['schemas']['ProductResponse']['data'];

const JD_MODE = 'product_key.jd.mode';
/**
 * BR-PROD-10 细则「按平台的搜索开关」: search.enabled.<platform> governs keyword search only;
 * a product detail is unaffected. Like parsing, a registered platform with a union adapter counts
 * as able to resolve (checked before any union call), so the detail never depends on the switch.
 */
const DETAIL_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: true,
  searchEnabled: false,
});
/** BR-PRICE-07 来源判定表: a detail without a source card is entry_source `detail` (→ risk). */
const DETAIL_ENTRY_SOURCE = 'detail';

function refExpired(message: string): never {
  throw new CatalogError(30143, `detail: ${message}`);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * BR-PROD-05 raw_item_id of a union response, taken as is: taobao item_id; jd skuId (sku mode)
 * or the whole itemId (item mode); pdd goods_sign. Never inferred from another field.
 */
export function detailRawItemId(item: UnionItemDetail, jdMode: string): string | undefined {
  switch (item.platform) {
    case 'taobao':
      return nonEmpty(item.item_id);
    case 'jd':
      return jdMode === 'sku' ? nonEmpty(item.skuId) : nonEmpty(item.itemId);
    case 'pdd':
      return nonEmpty(item.goods_sign);
    default:
      return undefined;
  }
}

/**
 * Union failure → contract code. Off shelf is 30141 (BR-PRICE-14). A dependency failure
 * (network / 5xx, throttling, governor timeout, open breaker, exhausted quota) has no usable cache
 * in this batch (no product pool yet), so it is the 「暂时查不到」 branch of BR-PRICE-11: 50401,
 * never another source dressed up as a price. A union refusal of the raw ID itself
 * (upstream_rejected / invalid_dto / link_unrecognized) is 30143 ref_expired (BR-PROD-05 结果分类
 * 「引用失效」). Anything else propagates unchanged.
 */
function upstreamFailure(error: unknown): unknown {
  if (error instanceof CatalogError) return error;
  if (
    (error instanceof UnionError && error.code === 'item_unavailable') ||
    (error instanceof DemoUnionError && error.code === 'demo_delisted')
  ) {
    return new CatalogError(30141, 'detail: item is off the shelf', undefined, { cause: error });
  }
  if (
    error instanceof UnionError &&
    (error.code === 'upstream_rejected' ||
      error.code === 'invalid_dto' ||
      error.code === 'link_unrecognized')
  ) {
    // BR-PROD-05 结果分类「引用失效」: the union refuses this raw ID itself.
    return new CatalogError(30143, 'detail: union rejected the raw item id', undefined, {
      cause: error,
    });
  }
  if (
    (error instanceof UnionError &&
      (error.code === 'upstream_unavailable' || error.code === 'rate_limited')) ||
    (error instanceof GovernanceError && error.code !== 'invalid_policy')
  ) {
    return new CatalogError(50401, 'detail: union temporarily unavailable', undefined, {
      cause: error,
    });
  }
  return error;
}

/**
 * GET /v1/products/{product_key} (04 §6.3; BR-PROD-03 / 05 / 11, BR-PRICE-05 / 07 / 11 / 12 / 14).
 * Order: request key → platform (20001 on a malformed or unregistered key) → item_ref (an
 * authenticated same-app token naming another product is 20001, before any union call) → raw ID
 * by BR-PROD-05 ① item_ref ≤ 1800 s, ② product_refs refreshed ≤ 1800 s, ③ re-resolve by key →
 * union detail (off shelf 30141, dependency failure 50401) → the single derivation
 * deriveProductKey; another key or none is 30143 → product_refs (source detail, receipt instant
 * from the Clock after the response) → the card entry (active query; quote, item_ref, link
 * registration). Every call registers a new link; a failed registration rejects the call, so no
 * unregistered link_id goes out. A valid item_ref whose raw ID was used is returned unchanged;
 * otherwise the card carries a freshly issued one.
 */
export async function getProduct(
  query: ProductDetailQuery,
  options: ProductDetailOptions,
): Promise<ProductDetailData> {
  const { clock, viewerContext, config, catalog, itemRefs, cards, upstream } = options;
  const productKey = query.product_key;
  const viewer = await viewerContext.current();
  const appId = viewer.appId;

  const rows = await catalog.listPlatforms();
  let platform: string;
  try {
    // Format and prefix only (BR-PROD-02): serving switches are checked by registerProductRef.
    platform = splitProductKey(
      productKey,
      rows.map((row) => ({
        platform: row.code,
        keyPrefix: row.key_prefix,
        parseEnabled: true,
        searchEnabled: true,
      })),
    ).platform;
  } catch (error: unknown) {
    if (error instanceof ProductKeyInvalid) {
      throw new CatalogError(20001, 'detail: product_key invalid', undefined, { cause: error });
    }
    throw error;
  }
  if (!isRegisteredPlatform(platform)) {
    // BR-PROD-03: only taobao, jd and pdd have product keys and a union adapter.
    throw new CatalogError(30131, 'detail: platform has no union adapter');
  }
  const row = rows.find((entry) => entry.code === platform);

  // ① The tapped card's token: 20001 on a same-app product mismatch, ignored when unusable.
  const token: RequestRawRef | null = itemRefs.verify({
    itemRef: query.item_ref ?? null,
    appId,
    productKey,
  });
  const nowMs = clock.now().getTime();
  let rawItemId: string | undefined;
  let tokenRaw: string | undefined;
  if (token !== null && token.platform === platform && isFresh(token.fetchedAt, nowMs)) {
    rawItemId = token.rawItemId;
    tokenRaw = token.rawItemId;
  } else {
    // ② product_refs of (app_id, product_key); refreshed_at is the stored receipt instant.
    const stored = await catalog.readProductRef({ appId, platform, productKey });
    if (stored !== null && isFresh(stored.receivedAt, nowMs)) rawItemId = stored.rawItemId;
  }

  const jdEntry = platform === 'jd' ? await config.configValue(appId, JD_MODE) : null;
  // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
  const jdMode = jdEntry === null ? 'item' : String(jdEntry.value);

  let item: UnionItemDetail;
  try {
    item = await upstream.detail({
      appId,
      productKey,
      platform,
      ...(platform === 'jd' ? { jdMode } : {}),
      ...(rawItemId === undefined ? {} : { rawItemId, requireRawMatch: true }),
    });
  } catch (error: unknown) {
    throw upstreamFailure(error);
  }
  // BR-PROD-05: refreshed_at is the receipt instant of this union response.
  const receivedAt = clock.now().toISOString();

  if (item.platform !== platform) refExpired('union answered for another platform');
  let derived: string;
  try {
    derived = deriveProductKey(
      {
        platform,
        keyPrefix: row?.key_prefix ?? null,
        ...(platform === 'jd' ? { jdMode: jdMode as 'item' | 'sku' } : {}),
      },
      item,
    );
  } catch (error: unknown) {
    if (error instanceof ProductKeyUnderivable) refExpired('product key not derivable');
    throw error;
  }
  if (derived !== productKey) refExpired('response derives another product key');
  const responseRaw = detailRawItemId(item, jdMode);
  if (responseRaw === undefined) refExpired('response carries no raw item id');

  const ref: ProductRef = {
    appId,
    platform,
    productKey,
    rawItemId: responseRaw,
    rawFetchedAt: item.quoted_at,
    receivedAt,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'detail',
  };
  await catalog.registerProductRef(ref, DETAIL_CAPABILITIES);

  const result = await cards.assemble({
    item,
    ref,
    entrySource: DETAIL_ENTRY_SOURCE,
    ...(query.from_link_id === undefined ? {} : { sourceLinkId: query.from_link_id }),
    stale: STALE_DETAILS.has(item),
    scene: 'active_query',
  });
  switch (result.kind) {
    case 'card':
      break;
    case 'price_unavailable':
      // D33 active query: no amount and no link_id; 50303 until F-37 gives the card a shape.
      // TODO(规划/11 §9.2): price_unavailable 卡的线上形状 — blocked on followups F-37 契约同步
      throw new CatalogError(50303, 'detail: price temporarily unavailable');
    default:
      throw new TypeError(`detail: unexpected card result ${result.kind}`);
  }
  // BR-PROD-11: a valid tapped token that supplied this call's raw ID goes back unchanged (原样
  // 透传), even if the union now reports another raw ID for the same key; otherwise the card's
  // freshly issued token stands.
  const card = result.card;
  return tokenRaw !== undefined && query.item_ref !== undefined
    ? { ...card, item_ref: query.item_ref }
    : card;
}
