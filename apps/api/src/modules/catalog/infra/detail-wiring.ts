// B1-05e: the union side of the product detail use case — one getItem on the governed adapter of
// the key's platform, called with the caller's app and purpose `online` (the governance wrapper
// adds signal, base URL and headers).
import { randomUUID } from 'node:crypto';
import type { ItemRef, UnionItemDetail } from '../../union/index.ts';
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

/**
 * Without a usable raw ID (no fresh item_ref, no fresh product_refs) BR-PROD-05 step ③ would
 * re-resolve the key, but no union entry looks a product up by its key, and a raw ID is never
 * rebuilt from the stable ID. Such a request is 30143 ref_expired (the client goes back to search).
 * TODO(规划/11 §4.5): 按 product_key 重新解析取原串 — blocked on 联盟按商品键检索的能力（CAP-*-03）
 */
export function createUnionDetailUpstream(options: {
  readonly union: GovernedUnion;
}): ProductDetailUpstream {
  const { union } = options;
  return {
    async detail(request: ProductDetailRequest): Promise<UnionItemDetail> {
      if (request.platform === undefined) {
        throw new CatalogError(30131, 'detail: platform has no union adapter');
      }
      if (request.rawItemId === undefined) {
        throw new CatalogError(30143, 'detail: no fresh raw item id to look the product up');
      }
      return union.adapter(request.platform).getItem(itemRefOf(request, request.rawItemId), {
        appId: request.appId,
        requestId: randomUUID(),
        purpose: 'online',
      });
    },
  };
}
