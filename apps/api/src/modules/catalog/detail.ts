import type { components } from '@couli/contracts-ts';
import type { Clock } from '../platform/index.ts';
import type { UnionItemDetail } from '../union/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import type { ItemRefService } from './application/item-ref.ts';
import type { Catalog } from './domain/types.ts';
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
  /** Absent means re-resolve the product key, never fabricate an upstream raw ID. */
  readonly rawItemId?: string;
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

/** GET /v1/products/{product_key}; implemented after the rule tests are reviewed. */
export async function getProduct(
  query: ProductDetailQuery,
  options: ProductDetailOptions,
): Promise<ProductDetailData> {
  void query;
  void options;
  throw new Error('NotImplemented: getProduct');
}
