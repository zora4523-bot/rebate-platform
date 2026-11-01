// B1-05e: the union side of the product detail use case — one getItem on the governed adapter of
// the key's platform, called with the caller's app and purpose `online`, or the purpose the caller
// names (the governance wrapper adds signal, base URL and headers).
import { randomUUID } from 'node:crypto';
import { ProductKeyUnderivable, deriveProductKey } from '@couli/domain';
import type { CallCtx, ItemRef, RegisteredPlatform, UnionItemDetail } from '../../union/index.ts';
import { searchRawByTitle } from '../application/pool-source.ts';
import type { RawReparser } from '../application/raw-reparse.ts';
import { CatalogError } from '../domain/rules.ts';
import type { ProductDetailRequest, ProductDetailUpstream } from '../detail.ts';
import type { GovernedUnion } from '../ports.ts';

/** The union ItemRef that carries a BR-PROD-05 raw ID, in the field that raw ID came from. */
function itemRefOf(request: ProductDetailRequest, rawItemId: string): ItemRef {
  switch (request.platform) {
    case 'taobao':
      return { platform: 'taobao', item_id: rawItemId };
    case 'jd':
      return request.jdMode === 'sku'
        ? { platform: 'jd', skuId: rawItemId }
        : { platform: 'jd', itemId: rawItemId };
    case 'pdd':
      return { platform: 'pdd', goods_sign: rawItemId };
    default:
      throw new CatalogError(30131, 'detail: platform has no union adapter');
  }
}

/** Does this search item derive the requested key? BR-PROD-03's single derivation. */
function derivesKey(
  request: ProductDetailRequest,
  keyPrefix: string | null,
  jdMode: string,
  item: ItemRef,
): boolean {
  try {
    const derived = deriveProductKey(
      {
        platform: item.platform,
        keyPrefix,
        ...(item.platform === 'jd' ? { jdMode: jdMode as 'item' | 'sku' } : {}),
      },
      item,
    );
    return derived === request.productKey;
  } catch (error: unknown) {
    if (error instanceof ProductKeyUnderivable) return false;
    throw error;
  }
}

/**
 * Without a usable raw ID (no fresh item_ref, no fresh product_refs) the union is asked only when the
 * request names a title to re-resolve by (BR-PROD-05 ③, a key with a qualifying pool row): a title
 * search for the key, then one getItem with the raw ID it gives. A search that answers without the
 * key, or a platform with no title search, is 30143; one that cannot answer now stays the union's
 * failure, for the cache and the pool's price. Any other request is 30143 without a union call: no
 * union entry looks a product up by its key alone, and a raw ID is never rebuilt from the stable ID.
 */
export function createUnionDetailUpstream(options: {
  readonly union: GovernedUnion;
  /** B1-05r: the product pool's refresh reads on its own quota purpose. */
  readonly purpose?: CallCtx['purpose'];
  /** B1-05w: BR-PROD-05 ③ with its write and lock (application/raw-reparse.ts). */
  readonly reparser?: RawReparser;
}): ProductDetailUpstream {
  const { union, purpose = 'online' } = options;

  function context(request: ProductDetailRequest): CallCtx {
    return { appId: request.appId, requestId: randomUUID(), purpose };
  }

  async function reparsedRaw(
    request: ProductDetailRequest,
    platform: RegisteredPlatform,
  ): Promise<string> {
    const { reparse, jdMode = 'item' } = request;
    if (reparse === undefined) {
      throw new CatalogError(30143, 'detail: no fresh raw item id to look the product up');
    }
    const found = await searchRawByTitle({
      adapter: union.adapter(platform),
      platform,
      title: reparse.title,
      jdMode,
      context: context(request),
      isTarget: (item) => derivesKey(request, reparse.keyPrefix, jdMode, item),
    });
    if (found === null) {
      throw new CatalogError(30143, 'detail: the title search does not hold this product');
    }
    return found.raw;
  }

  return {
    async detail(request: ProductDetailRequest): Promise<UnionItemDetail> {
      if (request.platform === undefined) {
        throw new CatalogError(30131, 'detail: platform has no union adapter');
      }
      const rawItemId = request.rawItemId ?? (await reparsedRaw(request, request.platform));
      return union
        .adapter(request.platform)
        .getItem(itemRefOf(request, rawItemId), context(request));
    },
  };
}
