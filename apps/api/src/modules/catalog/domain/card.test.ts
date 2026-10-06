import { describe, expect, it } from 'vitest';
import {
  ageSeconds,
  benefitTagsFor,
  ctaKeyFor,
  disclaimerKeysFor,
  quoteBasisFor,
  toPlusEight,
  unionSourceFor,
  zonedInstantMs,
} from './card.ts';

describe('card rules', () => {
  it('[AC-B1-05f] BR-PRICE-07: only listed sources are normal on taobao; other platforms normal', () => {
    expect(quoteBasisFor('taobao', 'share_landing')).toBe('normal');
    expect(quoteBasisFor('taobao', 'search')).toBe('price_compare_risk');
    expect(quoteBasisFor('taobao', null)).toBe('price_compare_risk');
    expect(quoteBasisFor('jd', 'search')).toBe('normal');
    expect(quoteBasisFor('pdd', null)).toBe('normal');
  });

  it('[AC-B1-05f] BR-PRICE-17 / 21: disclaimer order, cta and tags', () => {
    expect(disclaimerKeysFor('normal', 1n)).toEqual(['price_basis', 'rebate_estimate']);
    expect(disclaimerKeysFor('price_compare_risk', 1n)).toEqual(['price_basis', 'rebate_compare']);
    expect(disclaimerKeysFor('no_rebate', 1n)).toEqual(['price_basis']);
    expect(disclaimerKeysFor('normal', 0n)).toEqual(['price_basis.general', 'rebate_estimate']);
    expect(disclaimerKeysFor('price_compare_risk', 0n)).toEqual([
      'price_basis.general',
      'rebate_compare',
    ]);
    expect(disclaimerKeysFor('no_rebate', 0n)).toEqual(['price_basis.general']);
    expect(ctaKeyFor('no_rebate', 100n)).toBe('btn.buy.no_rebate');
    expect(ctaKeyFor('normal', 0n)).toBe('btn.buy');
    expect(ctaKeyFor('price_compare_risk', 1n)).toBe('btn.buy.coupon');
    expect(benefitTagsFor(0n)).toEqual([]);
    expect(benefitTagsFor(1n)).toEqual(['有券']);
    expect(unionSourceFor('pdd')).toBe('pdd_union');
    expect(() => unionSourceFor('meituan')).toThrow(TypeError);
  });

  it('[AC-B1-05f] BR-PRICE-11: zoned instants only, same instant in +08:00, floored age', () => {
    expect(() => zonedInstantMs('2026-10-06T10:00:00')).toThrow(TypeError);
    expect(() => zonedInstantMs('not a time')).toThrow(TypeError);
    const ms = zonedInstantMs('2026-10-05T23:30:00.250Z');
    expect(toPlusEight(ms)).toBe('2026-10-06T07:30:00.250+08:00');
    expect(toPlusEight(zonedInstantMs('2026-10-06T00:00:00+08:00'))).toBe(
      '2026-10-06T00:00:00+08:00',
    );
    expect(ageSeconds(ms, ms + 1999)).toBe(1);
    expect(ageSeconds(ms, ms - 5000)).toBe(0);
  });
});
