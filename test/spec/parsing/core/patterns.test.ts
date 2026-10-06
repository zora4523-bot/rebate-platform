import { expect, it } from 'vitest';
import { classifyParsingUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import { TABLE } from './kit.ts';

it.each([
  ['https://tb.example.test/item/a', 'taobao', 'product'],
  ['https://sub.TB.example.test.:8443/item/a?q=else#ignored', 'taobao', 'product'],
  ['https://tb.example.test/%69tem/a', 'taobao', 'product'],
  ['https://tb.example.test/item/%E4%B8%AD', 'taobao', 'product'],
  ['https://tb.example.test/item/%zz', 'taobao', 'product'],
  ['https://tb.example.test/item/%FF', 'taobao', 'product'],
  ['https://tb.example.test/deep/a%0Ab/c', 'taobao', 'product'],
  ['https://tb.example.test/literal/a.b', 'taobao', 'product'],
  ['https://promo.example.test/s/a/b', 'taobao', 'promo'],
  ['https://jd.example.test/item/b', 'jd', 'product'],
  ['https://pdd.example.test/item/c', 'pdd', 'product'],
  ['https://tb.example.test/store?url=/item/a#/item/a', 'taobao', 'union_host'],
  ['https://tb.example.test/ITEM/a', 'taobao', 'union_host'],
  ['https://tb.example.test/item/a/b', 'taobao', 'union_host'],
  ['https://tb.example.test/item/a%2Fb', 'taobao', 'union_host'],
  ['https://tb.example.test/%2569tem/a', 'taobao', 'union_host'],
  ['https://tb.example.test/literal/axb', 'taobao', 'union_host'],
] as const)('[AC-B1-07a-PATTERN] 主机路径形态：%s', (url, platform, category) => {
  expect(classifyParsingUrl(url, TABLE)).toEqual({ platform, category });
});

it.each([
  'https://tb.example.test.evil.test/item/a',
  'https://nottb.example.test/item/a',
  'https://unrelated.example.test/?next=https://tb.example.test/item/a',
  'https://tb.example.test@unrelated.example.test/item/a',
  'https://synthetic-user@tb.example.test/item/a',
  'http://tb.example.test/item/a',
  'javascript:synthetic()',
  'not a URL',
  'https://promo.example.test/elsewhere',
])('[AC-B1-07a-PATTERN-REJECT] 无合法形态命中：%s', (url) => {
  expect(classifyParsingUrl(url, TABLE)).toBeNull();
});

it('[AC-B1-07a-PATTERN-EMPTY] 空规则表不自行补造域名', () => {
  expect(
    classifyParsingUrl('https://tb.example.test/item/a', { version: '0', rules: [] }),
  ).toBeNull();
});

it('[AC-B1-07a-PATTERN-ORDER] union_host 与商品形态共存时不受规则顺序影响', () => {
  const url = 'https://tb.example.test/item/a';
  expect(classifyParsingUrl(url, { ...TABLE, rules: [...TABLE.rules].reverse() })).toEqual({
    platform: 'taobao',
    category: 'product',
  });
});
