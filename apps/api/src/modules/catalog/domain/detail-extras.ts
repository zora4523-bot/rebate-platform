// B1-05zk (D10-664 S-09 S09b, D10-736; 04 §8.3「商品详情专用字段」; contract CT-26s): the five
// detail-only keys of the GET /v1/products/{product_key} card, read from the union detail and the
// platform's switches (a switch is on only when its value is exactly `true`). shop_entry stays
// false until S-17. Skeleton only (test stage); rule tests: test/spec/catalog/detail-extras/**.
import type { components } from '@couli/contracts-ts';
import type { UnionItemDetail } from '../../union/index.ts';

type ProductCard = components['schemas']['ProductCard'];

/** The five keys as they go on the detail card (every key present). */
export type DetailExtras = Required<
  Pick<ProductCard, 'coupon_end_at' | 'sales_text' | 'shop_logo' | 'shop_scores' | 'shop_entry'>
>;

/** detail.coupon_end / detail.sales / detail.shop_scores .enabled.<platform>, already judged. */
export interface DetailExtraSwitches {
  readonly couponEnd: boolean;
  readonly sales: boolean;
  readonly shopScores: boolean;
}

/** A switch value counts as on only when it is exactly `true`. */
export function switchOn(value: unknown): boolean {
  void value;
  throw new Error('NotImplemented: switchOn');
}

/** The five keys of a union detail answer under the given switches. */
export function detailExtras(
  item: Pick<UnionItemDetail, 'coupon_end_at' | 'sales_text' | 'shop_logo' | 'shop_scores'>,
  switches: DetailExtraSwitches,
): DetailExtras {
  void item;
  void switches;
  throw new Error('NotImplemented: detailExtras');
}

/** The five keys of a card with nothing to show (pool fallback): null / null / null / [] / false. */
export function emptyDetailExtras(): DetailExtras {
  throw new Error('NotImplemented: emptyDetailExtras');
}
