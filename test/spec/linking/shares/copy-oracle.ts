// B1-15w: the share copy oracle (BR-TEXT-20 细则「分享页文案」, BR-PRICE-04 / 05 / 17, BR-TEXT-10 / 11,
// BR-PRICE-06), shared by the pure rule test of renderShareCopy and the HTTP cases. Written from
// the rules, not from an implementation:
// - parts in the order of ShareCopyParts: title, cleaned as BR-TEXT-20 renders #标题# (a leading
//   ^[【[]?(淘宝|天猫|京东|拼多多|美团|阿里|支付宝)[】\]]? removed, then every「官方」deleted; absent
//   when nothing is left; e.g.「【天猫】伊利官方旗舰店纯牛奶」→「伊利旗舰店纯牛奶」), and the copy's
//   first line never starts with a platform name; price_line「券后 ¥x · MM-DD 取价」with a coupon
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
// shareCopyViolations lists every broken rule (a property returns it empty as its boolean);
// expectShareCopy asserts that list is empty.
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

/** BR-TEXT-20: a title or first line starting with a platform name. */
const PLATFORM_LEAD = /^[【[]?(?:淘宝|天猫|京东|拼多多|美团|阿里|支付宝)/u;
/** BR-TEXT-20: the prefix removed from the product title before rendering. */
const PLATFORM_PREFIX = /^[【[]?(?:淘宝|天猫|京东|拼多多|美团|阿里|支付宝)[】\]]?/u;

/** #标题# as BR-TEXT-20 renders it: prefix removed, then「官方」deleted; null when nothing is left. */
export function cleanTitle(title: string | null): string | null {
  if (title === null) return null;
  const cleaned = title.replace(PLATFORM_PREFIX, '').replaceAll('官方', '');
  return cleaned === '' ? null : cleaned;
}

/** Every rule of the copy the facts break; empty when the copy is right. */
export function shareCopyViolations(copy: ShareCopy, facts: CopyFacts): string[] {
  const violations: string[] = [];
  const show = (value: unknown) => JSON.stringify(value);
  const same = (what: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) {
      violations.push(`${what}: ${show(actual)}, expected ${show(expected)}`);
    }
  };
  const pdd = facts.platform === 'pdd';
  const couponFen = facts.couponFen !== null && facts.couponFen > 0n ? facts.couponFen : null;
  const known: readonly string[] = PART_ORDER;
  const unknown = Object.keys(copy.parts).filter((key) => !known.includes(key));
  if (unknown.length > 0) violations.push(`parts not in ShareCopyParts: ${show(unknown)}`);

  const title = cleanTitle(facts.title);
  if (title !== null && (PLATFORM_LEAD.test(title) || title.includes('官方'))) {
    // Still a platform name or「官方」after cleaning: only the title part's own rule is fixed.
    const rendered = partOf(copy, 'title');
    if (rendered !== null && (PLATFORM_LEAD.test(rendered) || rendered.includes('官方'))) {
      violations.push(`title still starts with a platform name or has 官方: ${show(rendered)}`);
    }
  } else {
    same('title', partOf(copy, 'title'), title);
  }
  if (facts.finalPriceFen === null) {
    same('price_line', partOf(copy, 'price_line'), null);
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
    const expected = labels.map((label) => `${label} ${tail}`);
    const actual = partOf(copy, 'price_line');
    if (actual === null || !expected.includes(actual)) {
      violations.push(`price_line: ${show(actual)}, expected one of ${show(expected)}`);
    }
  }
  same(
    'pre_coupon_line',
    partOf(copy, 'pre_coupon_line'),
    couponFen === null || facts.priceFen === null
      ? null
      : `${pdd ? '拼单券前价' : '券前价'} ${yuan(facts.priceFen)}`,
  );
  same(
    'coupon_line',
    partOf(copy, 'coupon_line'),
    couponFen === null ? null : `券面额 ${yuan(couponFen)}`,
  );
  same(
    'tpwd_line',
    partOf(copy, 'tpwd_line'),
    facts.platform === 'taobao' && facts.tpwd !== null ? `复制 ${facts.tpwd} 打开淘宝` : null,
  );
  same(
    'link_line',
    partOf(copy, 'link_line'),
    facts.platform === 'taobao' ? null : `下单链接 ${facts.shareUrl}`,
  );

  const returned = PART_ORDER.filter((part) => partOf(copy, part) !== null);
  same(
    'include_default without repeats',
    new Set(copy.include_default).size,
    copy.include_default.length,
  );
  same('include_default', show([...copy.include_default].sort()), show([...returned].sort()));
  same(
    'default_text',
    copy.default_text,
    [
      ...returned.map((part) => partOf(copy, part)),
      couponFen === null ? PRICE_BASIS_GENERAL : PRICE_BASIS,
    ].join('\n'),
  );
  if (PLATFORM_LEAD.test(copy.default_text)) {
    violations.push(`default_text starts with a platform name: ${show(copy.default_text)}`);
  }

  const prices = [facts.finalPriceFen, couponFen === null ? null : facts.priceFen, couponFen];
  const allowed = prices.filter((fen): fen is bigint => fen !== null).map(yuan);
  for (const amount of copy.default_text.match(/¥[0-9]+(?:\.[0-9]+)?/g) ?? []) {
    if (!allowed.includes(amount)) violations.push(`amount ${amount} not among ${show(allowed)}`);
  }
  for (const word of EARNINGS_WORDS) {
    if (copy.default_text.includes(word)) {
      violations.push(`earnings wording「${word}」in default_text`);
    }
  }
  return violations;
}

export function expectShareCopy(copy: ShareCopy, facts: CopyFacts): void {
  expect(shareCopyViolations(copy, facts)).toEqual([]);
}
