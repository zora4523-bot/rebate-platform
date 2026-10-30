// B1-15w: the default copy of the share page (POST /v1/shares data.copy; BR-TEXT-20 细则「分享页文案」,
// BR-PRICE-04 / 05 / 17, BR-TEXT-10 / 11). Pure: rendered only from the fields the union returned for
// the product, the share link and the two price-basis texts. Rule tests:
// test/spec/linking/shares/copy.test.ts.
// - parts in ShareCopyParts order: title (#标题#: a leading platform name, bracketed or not, removed,
//   then every「官方」deleted, repeated until neither is left, so the copy never starts with a
//   platform name; nothing left → no title); price_line「券后 ¥x · MM-DD 取价」with a coupon
//   (coupon_fen > 0),「售价 ¥x · MM-DD 取价」without (Pinduoduo「拼单」before 券后 / 售价, BR-PRICE-05);
//   pre_coupon_line「券前价 ¥x」(Pinduoduo「拼单券前价 ¥x」) and coupon_line「券面额 ¥y」only with a
//   coupon; tpwd_line「复制 #口令# 打开淘宝」Taobao only; link_line「下单链接 #链接#」JD and Pinduoduo.
//   A part whose field the union did not return is null, never filled from another field.
// - include_default lists every returned part (all ticked by default); default_text joins them line
//   by line and ends with the fixed price-basis line (price_basis with a coupon, price_basis.general
//   without; BR-PRICE-17), which is not a part.
// - MM-DD is the Asia/Shanghai date of quoted_at (BR-TEXT-11); amounts are BR-TEXT-10 app yuan
//   (@couli/money formatYuan). No earnings amount is ever part of the copy (BR-PRICE-06).
import type { components } from '@couli/contracts-ts';
import { formatYuan } from '@couli/money';

export type ShareCopy = components['schemas']['ShareCopy'];
type Part = components['schemas']['ShareCopyPart'];
type Parts = components['schemas']['ShareCopyParts'];

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

/** ShareCopyParts in contract order: the order default_text joins them in. */
export const SHARE_COPY_PARTS: readonly Part[] = Object.freeze([
  'title',
  'price_line',
  'pre_coupon_line',
  'coupon_line',
  'tpwd_line',
  'link_line',
]);

/** BR-TEXT-20: the platform-name prefix removed from the product title before rendering. */
const PLATFORM_PREFIX = /^[【[]?(?:淘宝|天猫|京东|拼多多|美团|阿里|支付宝)[】\]]?/u;
const OFFICIAL = '官方';

/** MM-DD in Asia/Shanghai (BR-TEXT-11); formatToParts of an epoch, no Date constructed here. */
const SHANGHAI_MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
});

/**
 * #标题# as BR-TEXT-20 renders it: the leading platform name removed, then「官方」deleted — repeated
 * while either is still there (a deletion may leave a new one), so the result neither starts with a
 * platform name nor contains「官方」. Line breaks become spaces (the copy is joined by lines).
 * null when nothing is left.
 */
export function cleanShareTitle(title: string | null): string | null {
  if (title === null) return null;
  let current = title.replace(/[\r\n]+/g, ' ');
  for (;;) {
    const next = current.replace(PLATFORM_PREFIX, '').replaceAll(OFFICIAL, '');
    if (next === current) break;
    current = next;
  }
  return current === '' ? null : current;
}

/** MM-DD of the instant in Asia/Shanghai. */
export function shanghaiMonthDay(at: Date): string {
  const parts = SHANGHAI_MONTH_DAY.formatToParts(at.getTime());
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function renderShareCopy(facts: ShareCopyFacts, texts: SharePriceBasisTexts): ShareCopy {
  const pdd = facts.platform === 'pdd';
  const coupon = facts.couponFen !== null && facts.couponFen > 0n ? facts.couponFen : null;
  const label = (name: string) => (pdd ? `拼单${name}` : name);

  const parts: Record<Part, string | null> = {
    title: cleanShareTitle(facts.title),
    price_line:
      facts.finalPriceFen === null
        ? null
        : `${label(coupon === null ? '售价' : '券后')} ${formatYuan(facts.finalPriceFen)} · ${shanghaiMonthDay(facts.quotedAt)} 取价`,
    pre_coupon_line:
      coupon === null || facts.priceFen === null
        ? null
        : `${label('券前价')} ${formatYuan(facts.priceFen)}`,
    coupon_line: coupon === null ? null : `券面额 ${formatYuan(coupon)}`,
    tpwd_line:
      facts.platform === 'taobao' && facts.tpwd !== null && facts.tpwd !== ''
        ? `复制 ${facts.tpwd} 打开淘宝`
        : null,
    link_line: facts.platform === 'taobao' ? null : `下单链接 ${facts.shareUrl}`,
  };

  const returned = SHARE_COPY_PARTS.filter((part) => parts[part] !== null);
  const lines = returned.map((part) => parts[part] as string);
  lines.push(coupon === null ? texts.general : texts.withCoupon);
  const rendered: Parts = { ...parts };
  return {
    default_text: lines.join('\n'),
    parts: rendered,
    include_default: [...returned],
  };
}
