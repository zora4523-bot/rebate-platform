// B1-05e: the union side of the product detail use case — one getItem on the governed adapter of
// the key's platform, called with the caller's app and purpose `online`, or the purpose the caller
// names (the governance wrapper adds signal, base URL and headers).
import { randomUUID } from 'node:crypto';
import { ProductKeyUnderivable, deriveProductKey } from '@couli/domain';
import {
  UnionError,
  type CallCtx,
  type ItemRef,
  type RegisteredPlatform,
  type UnionItemDetail,
} from '../../union/index.ts';
import { parseRaw, type RawReparser } from '../application/raw-reparse.ts';
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
 * request names what to re-resolve by (BR-PROD-05 ③, a key with a product_refs row or a qualifying
 * pool row): the shared re-parse, then one getItem with the raw ID it gives. 下架 is 30141; a search
 * that answers without the key, or a platform with no title search, is 30143; one that cannot answer
 * now stays a union failure, for the cache and the pool's price. Any other request is 30143 without a
 * union call: no union entry looks a product up by its key alone, and a raw ID is never rebuilt from
 * the stable ID. Without a reparser there is no lock, and the use case's own write stands for 步骤 4.
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
    const target = {
      appId: request.appId,
      platform,
      productKey: request.productKey,
      jdMode,
      canonicalUrl: reparse.canonicalUrl ?? null,
      title: reparse.title,
      source: 'detail',
      isTarget: (item: ItemRef) => derivesKey(request, reparse.keyPrefix, jdMode, item),
    } as const;
    const result =
      options.reparser === undefined
        ? await parseRaw(union, target, purpose)
        : await options.reparser.reparse(target);
    switch (result.kind) {
      case 'found':
        return result.ref.rawItemId;
      case 'off_shelf':
        throw new CatalogError(30141, 'detail: item is off the shelf');
      case 'ref_expired':
        throw new CatalogError(30143, 'detail: the union does not hold this product any more');
      case 'temporary_failure':
        throw new UnionError('upstream_unavailable', 'detail: re-parse failed', platform);
    }
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
