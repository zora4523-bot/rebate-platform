// B1-15w unit tests of the share copy helpers (the rule tests are test/spec/linking/shares/copy.test.ts).
import { describe, expect, it } from 'vitest';
import {
  cleanShareTitle,
  renderShareCopy,
  shanghaiMonthDay,
  type ShareCopyFacts,
} from './share-copy.ts';

const TEXTS = { withCoupon: '有券口径', general: '无券口径' };
const AT = new Date(Date.parse('2026-10-05T01:30:00.000Z'));

function facts(overrides: Partial<ShareCopyFacts> = {}): ShareCopyFacts {
  return {
    platform: 'jd',
    title: '演示商品',
    priceFen: 5990n,
    couponFen: 1000n,
    finalPriceFen: 4990n,
    quotedAt: AT,
    shareUrl: 'https://u.example.test/s1',
    tpwd: null,
    ...overrides,
  };
}

describe('share copy (B1-15w)', () => {
  it('[AC-B1-15w] the title is cleaned until neither a platform prefix nor 官方 is left', () => {
    expect(cleanShareTitle('官官方方伊利')).toBe('伊利');
    expect(cleanShareTitle('【淘宝】天猫伊利')).toBe('伊利');
    expect(cleanShareTitle('京东官方')).toBeNull();
    expect(cleanShareTitle('伊利\n纯牛奶')).toBe('伊利 纯牛奶');
    expect(cleanShareTitle(null)).toBeNull();
  });

  it('[AC-B1-15w] MM-DD is the Asia/Shanghai date', () => {
    expect(shanghaiMonthDay(new Date(Date.parse('2026-12-31T16:00:00.000Z')))).toBe('01-01');
    expect(shanghaiMonthDay(new Date(Date.parse('2026-03-01T15:59:59.999Z')))).toBe('03-01');
  });

  it('[AC-B1-15w] Pinduoduo prices carry 拼单 before 券后 / 售价 / 券前价', () => {
    const withCoupon = renderShareCopy(facts({ platform: 'pdd' }), TEXTS);
    expect(withCoupon.parts.price_line).toBe('拼单券后 ¥49.9 · 10-05 取价');
    expect(withCoupon.parts.pre_coupon_line).toBe('拼单券前价 ¥59.9');
    const without = renderShareCopy(
      facts({ platform: 'pdd', couponFen: 0n, finalPriceFen: 5990n }),
      TEXTS,
    );
    expect(without.parts.price_line).toBe('拼单售价 ¥59.9 · 10-05 取价');
    expect(without.default_text.endsWith('\n无券口径')).toBe(true);
  });

  it('[AC-B1-15w] Taobao without a token has neither a token nor a link line', () => {
    const copy = renderShareCopy(facts({ platform: 'taobao', tpwd: '' }), TEXTS);
    expect(copy.parts.tpwd_line).toBeNull();
    expect(copy.parts.link_line).toBeNull();
    expect(copy.include_default).toEqual(['title', 'price_line', 'pre_coupon_line', 'coupon_line']);
    expect(copy.default_text.split('\n').at(-1)).toBe('有券口径');
  });

  it('[AC-B1-15w] nothing returned but the link still ends with the price-basis line', () => {
    const copy = renderShareCopy(
      facts({ title: null, priceFen: null, couponFen: null, finalPriceFen: null }),
      TEXTS,
    );
    expect(copy.include_default).toEqual(['link_line']);
    expect(copy.default_text).toBe('下单链接 https://u.example.test/s1\n无券口径');
  });
});
