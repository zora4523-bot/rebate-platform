// B1-15w rule tests: the share page's default copy (BR-TEXT-20 细则「分享页文案」; contract ShareCopy,
// CT-15t examples), pure — renderShareCopy over the fields the union returned. The oracle is
// copy-oracle.ts; the HTTP cases check the same copy on POST /v1/shares. The property's runs and
// seed come only from @couli/testing (PROP_RUNS / PROP_SEED) and it returns a boolean.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  renderShareCopy,
  type ShareCopyFacts,
} from '../../../../apps/api/src/modules/linking/domain/share-copy.ts';
import {
  PRICE_BASIS,
  PRICE_BASIS_GENERAL,
  expectShareCopy,
  partOf,
  shareCopyViolations,
} from './copy-oracle.ts';

const TEXTS = { withCoupon: PRICE_BASIS, general: PRICE_BASIS_GENERAL };
const TITLE = '伊利纯牛奶 250ml×24 盒';

it('[AC-B1-15w#5] 契约示例（淘宝有券）：标题、券后价与取价日期、券前价、券面额、口令一行，末行 price_basis；无链接行，五段全选', () => {
  const copy = renderShareCopy(
    {
      platform: 'taobao',
      title: TITLE,
      priceFen: 5990n,
      couponFen: 1000n,
      finalPriceFen: 4990n,
      quotedAt: new Date('2026-10-05T09:30:00+08:00'),
      shareUrl: 'https://s.click.example.test/t?e=share90',
      tpwd: '₤AbCd1234₤',
    },
    TEXTS,
  );
  expect(copy.default_text).toBe(
    `伊利纯牛奶 250ml×24 盒\n券后 ¥49.9 · 10-05 取价\n券前价 ¥59.9\n券面额 ¥10\n复制 ₤AbCd1234₤ 打开淘宝\n${PRICE_BASIS}`,
  );
  expect(copy.parts).toMatchObject({
    title: TITLE,
    price_line: '券后 ¥49.9 · 10-05 取价',
    pre_coupon_line: '券前价 ¥59.9',
    coupon_line: '券面额 ¥10',
    tpwd_line: '复制 ₤AbCd1234₤ 打开淘宝',
  });
  expect(partOf(copy, 'link_line')).toBeNull();
  expect([...copy.include_default].sort()).toEqual(
    ['title', 'price_line', 'pre_coupon_line', 'coupon_line', 'tpwd_line'].sort(),
  );
});

it('[AC-B1-15w#5] 契约示例（京东无券）：售价写法、不出现「券后」，没有券前价、券面额与口令段，下单链接一行，末行 price_basis.general', () => {
  const copy = renderShareCopy(
    {
      platform: 'jd',
      title: TITLE,
      priceFen: 5990n,
      couponFen: 0n,
      finalPriceFen: 5990n,
      quotedAt: new Date('2026-10-05T09:30:00+08:00'),
      shareUrl: 'https://u.example.test/share91',
      tpwd: null,
    },
    TEXTS,
  );
  expect(copy.default_text).toBe(
    `伊利纯牛奶 250ml×24 盒\n售价 ¥59.9 · 10-05 取价\n下单链接 https://u.example.test/share91\n${PRICE_BASIS_GENERAL}`,
  );
  expect(copy.default_text).not.toContain('券后');
  for (const part of ['pre_coupon_line', 'coupon_line', 'tpwd_line'] as const) {
    expect(partOf(copy, part)).toBeNull();
  }
  expect([...copy.include_default].sort()).toEqual(['title', 'price_line', 'link_line'].sort());
});

it('[AC-B1-15w#5] 拼多多有券：券前价写作「拼单券前价」；取价日期按北京时间（UTC 当日 16:30 已是次日）', () => {
  const facts: ShareCopyFacts = {
    platform: 'pdd',
    title: TITLE,
    priceFen: 5990n,
    couponFen: 1000n,
    finalPriceFen: 4990n,
    quotedAt: new Date('2026-10-30T16:30:00.000Z'),
    shareUrl: 'https://p.example.test/share92',
    tpwd: null,
  };
  const copy = renderShareCopy(facts, TEXTS);
  expect(partOf(copy, 'pre_coupon_line')).toBe('拼单券前价 ¥59.9');
  expect(partOf(copy, 'price_line')).toMatch(/^(拼单)?券后 ¥49\.9 · 10-31 取价$/);
  expectShareCopy(copy, facts);
});

it('[AC-B1-15w#5] 联盟没返回的字段：所在段整段不出现、不进 include_default，也不用别的字段补（无标题、无券前价、无券后价时只剩券面额与下单链接）', () => {
  const facts: ShareCopyFacts = {
    platform: 'jd',
    title: null,
    priceFen: null,
    couponFen: 1000n,
    finalPriceFen: null,
    quotedAt: new Date('2026-10-30T02:00:00.000Z'),
    shareUrl: 'https://u.example.test/share93',
    tpwd: null,
  };
  const copy = renderShareCopy(facts, TEXTS);
  expect(copy.default_text).toBe(
    `券面额 ¥10\n下单链接 https://u.example.test/share93\n${PRICE_BASIS}`,
  );
  expect([...copy.include_default].sort()).toEqual(['coupon_line', 'link_line'].sort());
  expectShareCopy(copy, facts);
});

it.each([
  ['taobao', '【天猫】伊利官方旗舰店纯牛奶', '伊利旗舰店纯牛奶'],
  ['jd', '[京东]伊利纯牛奶 250ml×24 盒', '伊利纯牛奶 250ml×24 盒'],
  ['pdd', '拼多多官方补贴 伊利纯牛奶', '补贴 伊利纯牛奶'],
  ['taobao', '【淘宝伊利纯牛奶官方', '伊利纯牛奶'],
] as const)(
  '[AC-B1-15w#5] %s 标题「%s」：按 BR-TEXT-20 去掉开头的平台名前缀并删除「官方」，文案首行为「%s」',
  (platform, title, cleaned) => {
    const facts: ShareCopyFacts = {
      platform,
      title,
      priceFen: 5990n,
      couponFen: 1000n,
      finalPriceFen: 4990n,
      quotedAt: new Date('2026-10-05T09:30:00+08:00'),
      shareUrl: 'https://u.example.test/share94',
      tpwd: platform === 'taobao' ? '₤AbCd1234₤' : null,
    };
    const copy = renderShareCopy(facts, TEXTS);
    expect(partOf(copy, 'title')).toBe(cleaned);
    expect(copy.default_text.split('\n')[0]).toBe(cleaned);
    expect(copy.include_default).toContain('title');
    expectShareCopy(copy, facts);
  },
);

it('[AC-B1-15w#5] 标题清洗后为空（「【天猫】官方」）：标题段不出现、不进 include_default，文案首行即价格行', () => {
  const facts: ShareCopyFacts = {
    platform: 'jd',
    title: '【天猫】官方',
    priceFen: 5990n,
    couponFen: 0n,
    finalPriceFen: 5990n,
    quotedAt: new Date('2026-10-05T09:30:00+08:00'),
    shareUrl: 'https://u.example.test/share95',
    tpwd: null,
  };
  const copy = renderShareCopy(facts, TEXTS);
  expect(partOf(copy, 'title')).toBeNull();
  expect(copy.include_default).not.toContain('title');
  expect(copy.default_text).toBe(
    `售价 ¥59.9 · 10-05 取价\n下单链接 https://u.example.test/share95\n${PRICE_BASIS_GENERAL}`,
  );
  expectShareCopy(copy, facts);
});

/** Title prefixes BR-TEXT-20 removes (with and without brackets) and none. */
const TITLE_PREFIXES = [
  '',
  '',
  '【天猫】',
  '【淘宝】',
  '[京东]',
  '拼多多',
  '【拼多多',
  '支付宝]',
  '美团',
];
/**
 * Title body pieces: no platform name, no white space (08 says nothing of trimming) and「官」「方」
 * only as「官方」, so the cleaned title is determined (deleting「官方」never leaves a new one or a
 * platform name at the start).
 */
const TITLE_PIECES = [
  ...Array.from('伊利纯牛奶盒装演示商品抽纸洗衣液旗舰店0123456789mlx×'),
  '官方',
  '官方',
];
/** Chars from `first` to `last` by char code, minus those in `excluded`. */
function charRange(first: string, last: string, excluded: string): string[] {
  const chars: string[] = [];
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    const char = String.fromCharCode(code);
    if (!excluded.includes(char)) chars.push(char);
  }
  return chars;
}

// A–Z without I, O (24), a–z without i, l, o (23), 2–9 (8): TPWD_ALPHABET.length === 55.
const TPWD_ALPHABET = [
  ...charRange('A', 'Z', 'IO'),
  ...charRange('a', 'z', 'ilo'),
  ...charRange('2', '9', ''),
];

/** Consistent union prices (final = price − coupon), each field independently not returned. */
const factsArb: fc.Arbitrary<ShareCopyFacts> = fc
  .record({
    platform: fc.constantFrom('taobao' as const, 'jd' as const, 'pdd' as const),
    title: fc.oneof(
      fc.constant(null),
      fc.constant(''),
      fc
        .tuple(
          fc.constantFrom(...TITLE_PREFIXES),
          fc.array(fc.constantFrom(...TITLE_PIECES), { minLength: 0, maxLength: 24 }),
        )
        .map(([prefix, pieces]) => `${prefix}${pieces.join('')}`),
    ),
    // 0 and 1 fen, ordinary prices, and amounts past 2^31 (up to 2^53 − 1).
    price: fc.oneof(
      fc.constantFrom(0n, 1n),
      fc.bigInt({ min: 2n, max: 99_999_999n }),
      fc.bigInt({ min: 2_147_483_648n, max: 9_007_199_254_740_991n }),
    ),
    couponPercent: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 90 })),
    dropPrice: fc.constantFrom(false, false, false, true),
    dropCoupon: fc.constantFrom(false, false, false, true),
    dropFinal: fc.constantFrom(false, false, false, true),
    quotedAtMs: fc.integer({
      min: Date.parse('2026-01-01T00:00:00.000Z'),
      max: Date.parse('2027-12-31T23:59:59.999Z'),
    }),
    shareUrl: fc.webUrl({ validSchemes: ['https'] }),
    token: fc
      .array(fc.constantFrom(...TPWD_ALPHABET), { minLength: 8, maxLength: 12 })
      .map((chars) => `￥${chars.join('')}￥`),
  })
  .map((drawn) => {
    // Below 100 fen a percentage above 0 may still leave a coupon of 0: a product without one.
    const coupon = (drawn.price * BigInt(drawn.couponPercent)) / 100n;
    return {
      platform: drawn.platform,
      title: drawn.title,
      priceFen: drawn.dropPrice ? null : drawn.price,
      couponFen: drawn.dropCoupon ? null : coupon,
      finalPriceFen: drawn.dropFinal ? null : drawn.price - coupon,
      quotedAt: new Date(drawn.quotedAtMs),
      shareUrl: drawn.shareUrl,
      tpwd: drawn.platform === 'taobao' ? drawn.token : null,
    };
  });

// The timeout grows with PROP_RUNS (10 000 locally, 100 000 in the long run).
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[AC-B1-15w#5] 任意平台、标题与价格组合：标题按 BR-TEXT-20 清洗，各段只按联盟实际返回的字段渲染，include_default 只列返回的段，default_text 逐行拼接并以价格口径说明收尾，文案里只有返回的价格、没有收益字样',
  () => {
    fc.assert(
      fc.property(
        factsArb,
        (facts) => shareCopyViolations(renderShareCopy(facts, TEXTS), facts).length === 0,
      ),
      propParams(),
    );
  },
  PROPERTY_TIMEOUT_MS,
);
