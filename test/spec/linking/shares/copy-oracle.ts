// B1-15w: the share copy oracle (BR-TEXT-20 细则「分享页文案」, BR-PRICE-04 / 05 / 17, BR-TEXT-10 / 11,
// BR-PRICE-06), shared by the pure rule test of renderShareCopy and the HTTP cases. Written from
// the rules, not from an implementation:
// - parts in the order of ShareCopyParts: title; price_line「券后 ¥x · MM-DD 取价」with a coupon
//   (coupon_fen > 0),「售价 ¥x · MM-DD 取价」without; pre_coupon_line「券前价 ¥x」(Pinduoduo
//  「拼单券前价 ¥x」) and coupon_line「券面额 ¥y」only with a coupon; tpwd_line「复制 #口令# 打开淘宝」
//   Taobao only; link_line「下单链接 #链接#」JD and Pinduoduo only (the default template has one
//   token-or-link line). A part whose field the union did not return is absent or null (read
//   alike), never filled from another field or an estimate;
// - Pinduoduo's price label: BR-PRICE-04 puts「拼单」before 券后 / 售价 on cards, 08 does not fix it
//   for the share copy's price_line, so both spellings are accepted there;
// - include_default lists exactly the returned parts (all ticked by default); default_text joins
//   them in that order and ends with the fixed price-basis line (price_basis with a coupon,
//   price_basis.general without, contracts/texts.default.json);
// - MM-DD is the Asia/Shanghai date of quoted_at (BR-TEXT-11); amounts are BR-TEXT-10 app yuan;
// - no amount other than the returned prices and no earnings wording anywhere in the copy.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';

export type ShareCopy = components['schemas']['ShareCopy'];
type Part = components['schemas']['ShareCopyPart'];
export type CopyPlatform = 'taobao' | 'jd' | 'pdd';

/** ShareCopyParts in contract order: the order default_text joins them in. */
export const PART_ORDER: readonly Part[] = [
  'title',
  'price_line',
  'pre_coupon_line',
  'coupon_line',
  'tpwd_line',
  'link_line',
];

const TEXTS = (
  JSON.parse(
    readFileSync(new URL('../../../../contracts/texts.default.json', import.meta.url), 'utf8'),
  ) as { texts: Record<string, string> }
).texts;
/** BR-PRICE-17: the price-basis line with a coupon and without one. */
export const PRICE_BASIS = String(TEXTS['price_basis']);
export const PRICE_BASIS_GENERAL = String(TEXTS['price_basis.general']);

/** Earnings wording that never reaches the copy (BR-PRICE-06, BR-TEXT-20 细则「收益金额」). */
export const EARNINGS_WORDS: readonly string[] = ['返', '收益', '佣金', '推广', '赚'];

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** BR-TEXT-10 app display: yuan, at most two decimals, trailing zeros removed. */
export function yuan(fen: bigint): string {
  const whole = fen / 100n;
  const cent = fen % 100n;
  if (cent === 0n) return `¥${whole}`;
  if (cent % 10n === 0n) return `¥${whole}.${cent / 10n}`;
  return `¥${whole}.${cent.toString().padStart(2, '0')}`;
}

/** MM-DD of the instant in Asia/Shanghai (BR-TEXT-11; no daylight saving). */
export function monthDay(at: Date): string {
  const local = new Date(at.getTime() + SHANGHAI_OFFSET_MS);
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  return `${month}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

/** The facts a copy is checked against: only what the union returned (null: not returned). */
export interface CopyFacts {
  readonly platform: CopyPlatform;
  readonly title: string | null;
  readonly priceFen: bigint | null;
  readonly couponFen: bigint | null;
  readonly finalPriceFen: bigint | null;
  readonly quotedAt: Date;
  readonly shareUrl: string;
  readonly tpwd: string | null;
}

/** Absent and null are read alike (ShareCopyParts). */
export function partOf(copy: ShareCopy, part: Part): string | null {
  const value = copy.parts[part];
  return value === undefined ? null : value;
}

export function expectShareCopy(copy: ShareCopy, facts: CopyFacts): void {
  const pdd = facts.platform === 'pdd';
  const couponFen = facts.couponFen !== null && facts.couponFen > 0n ? facts.couponFen : null;
  const known: readonly string[] = PART_ORDER;
  expect(Object.keys(copy.parts).filter((key) => !known.includes(key))).toEqual([]);

  expect(partOf(copy, 'title')).toBe(facts.title === '' ? null : facts.title);
  if (facts.finalPriceFen === null) {
    expect(partOf(copy, 'price_line')).toBeNull();
  } else {
    const tail = `${yuan(facts.finalPriceFen)} · ${monthDay(facts.quotedAt)} 取价`;
    const labels =
      couponFen !== null
        ? pdd
          ? ['券后', '拼单券后']
          : ['券后']
        : pdd
          ? ['售价', '拼单售价', '拼单价']
          : ['售价'];
    expect(labels.map((label) => `${label} ${tail}`)).toContain(partOf(copy, 'price_line'));
  }
  expect(partOf(copy, 'pre_coupon_line')).toBe(
    couponFen === null || facts.priceFen === null
      ? null
      : `${pdd ? '拼单券前价' : '券前价'} ${yuan(facts.priceFen)}`,
  );
  expect(partOf(copy, 'coupon_line')).toBe(couponFen === null ? null : `券面额 ${yuan(couponFen)}`);
  expect(partOf(copy, 'tpwd_line')).toBe(
    facts.platform === 'taobao' && facts.tpwd !== null ? `复制 ${facts.tpwd} 打开淘宝` : null,
  );
  expect(partOf(copy, 'link_line')).toBe(
    facts.platform === 'taobao' ? null : `下单链接 ${facts.shareUrl}`,
  );

  const returned = PART_ORDER.filter((part) => partOf(copy, part) !== null);
  expect(new Set(copy.include_default).size).toBe(copy.include_default.length);
  expect([...copy.include_default].sort()).toEqual([...returned].sort());
  expect(copy.default_text).toBe(
    [
      ...returned.map((part) => partOf(copy, part)),
      couponFen === null ? PRICE_BASIS_GENERAL : PRICE_BASIS,
    ].join('\n'),
  );

  const prices = [facts.finalPriceFen, couponFen === null ? null : facts.priceFen, couponFen];
  const allowed = prices.filter((fen): fen is bigint => fen !== null).map(yuan);
  for (const amount of copy.default_text.match(/¥[0-9]+(?:\.[0-9]+)?/g) ?? []) {
    expect(allowed).toContain(amount);
  }
  for (const word of EARNINGS_WORDS) expect(copy.default_text).not.toContain(word);
}
