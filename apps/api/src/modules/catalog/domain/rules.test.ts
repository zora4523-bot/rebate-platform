import { expect, it } from 'vitest';
import {
  RAW_ID_MAX_AGE_MS,
  effectiveCapabilities,
  filterByRules,
  isFresh,
  isPlatformServed,
  isProductRefSource,
} from './rules.ts';
import type { PlatformRecord } from './types.ts';

const record: PlatformRecord = {
  code: 'taobao',
  key_prefix: 'tb',
  key_stability: 'unverified',
  search_support: 'supported',
  convert_support: 'none',
  order_sync_support: 'supported',
  stage: 'm_beta',
};

it('[AC-B1-05c] freshness includes the 1800 s boundary and rejects unparsable instants', () => {
  const at = Date.parse('2031-01-01T00:00:00.000Z');
  expect(isFresh('2031-01-01T00:00:00.000Z', at + RAW_ID_MAX_AGE_MS)).toBe(true);
  expect(isFresh('2031-01-01T00:00:00.000Z', at + RAW_ID_MAX_AGE_MS + 1)).toBe(false);
  expect(isFresh('not an instant', at)).toBe(false);
});

it('[AC-B1-05c] a search switch cannot enable a platform whose dictionary has no search', () => {
  const none = { ...record, search_support: 'none' };
  expect(isPlatformServed(none, { parseEnabled: false, searchEnabled: true })).toBe(false);
  expect(isPlatformServed(none, { parseEnabled: true, searchEnabled: false })).toBe(true);
  expect(isPlatformServed(record, { parseEnabled: false, searchEnabled: true })).toBe(true);
  expect(effectiveCapabilities(none, { parseEnabled: true, searchEnabled: true })).toEqual({
    parseEnabled: true,
    searchEnabled: false,
  });
});

it('[AC-B1-05c] only the four product_refs sources are accepted, case-sensitively', () => {
  for (const source of ['search', 'detail', 'parse', 'pool']) {
    expect(isProductRefSource(source)).toBe(true);
  }
  for (const source of ['order', 'SEARCH', '', null])
    expect(isProductRefSource(source)).toBe(false);
});

it('[AC-B1-05c] category rules match platform and category, keyword as a literal substring', () => {
  const items = [
    { platform: 'taobao', categoryId: '1', title: 'x.y' },
    { platform: 'taobao', categoryId: '1', title: 'xzy' },
    { platform: 'jd', categoryId: '1', title: 'x.y' },
  ] as const;
  expect(filterByRules(items, [{ platform: 'taobao', categoryId: '1', keyword: '.' }])).toEqual([
    items[1],
    items[2],
  ]);
  expect(filterByRules(items, [{ platform: 'taobao', categoryId: '1', keyword: null }])).toEqual([
    items[2],
  ]);
  expect(filterByRules(items, [])).toEqual(items);
});
