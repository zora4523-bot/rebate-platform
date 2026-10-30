// B1-15w: the default copy of the share page (POST /v1/shares data.copy; BR-TEXT-20 细则「分享页文案」,
// BR-PRICE-04 / 05 / 17, BR-TEXT-10 / 11). Pure: rendered only from the fields the union returned for
// the product, the share link and the two price-basis texts. Rule tests:
// test/spec/linking/shares/copy.test.ts.
import type { components } from '@couli/contracts-ts';

export type ShareCopy = components['schemas']['ShareCopy'];

/** What the copy is rendered from; null: the union did not return the field for this product. */
export interface ShareCopyFacts {
  readonly platform: 'taobao' | 'jd' | 'pdd';
  readonly title: string | null;
  /** price_fen (券前价). */
  readonly priceFen: bigint | null;
  /** coupon_fen; the product has a coupon only when it is above 0. */
  readonly couponFen: bigint | null;
  /** final_price_fen (券后价 with a coupon, 售价 without). */
  readonly finalPriceFen: bigint | null;
  /** quoted_at of the union response the prices come from. */
  readonly quotedAt: Date;
  /** The share link (share_url) of this call. */
  readonly shareUrl: string;
  /** The Taobao token; null for JD and Pinduoduo. */
  readonly tpwd: string | null;
}

/** The fixed last line (BR-PRICE-17): text keys price_basis and price_basis.general. */
export interface SharePriceBasisTexts {
  readonly withCoupon: string;
  readonly general: string;
}

export function renderShareCopy(facts: ShareCopyFacts, texts: SharePriceBasisTexts): ShareCopy {
  void facts;
  void texts;
  throw new Error('NotImplemented: renderShareCopy');
}
