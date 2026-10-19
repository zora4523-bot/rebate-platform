import { expect, it } from 'vitest';
import { findSpecInTitle, normalizeSpec } from './index.ts';

// BR-AI-24 细则「规格比对」：先去空白再比较；数字边界只在去空白后的连续数字上判断。

it.each([
  ['24盒', '合成牛奶2 4盒', '24盒'],
  ['24盒', '合成牛奶2\t4 盒装', '24盒'],
  ['24盒', '合成牛奶二 十四盒', '二十四盒'],
  ['500毫升', '合成饮品500毫 升', '500毫升'],
  ['500ml', '合成饮品5 00 毫 升装', '500毫升'],
  ['500ml', '合成饮品500m l', '500ml'],
  ['2 4盒', '合成牛奶24盒', '24盒'],
  ['500毫 升', '合成饮品500ml', '500ml'],
])('去空白后一致：规格 %s 与标题 %s → %s', (spec, title, fragment) => {
  expect(findSpecInTitle(spec, title)).toBe(fragment);
});

it.each([
  ['24盒', '合成牛奶124盒'],
  ['24盒', '合成牛奶1 24盒'],
  ['24盒', '合成牛奶240盒'],
  ['24盒', '合成牛奶24 0盒'],
  ['24盒', '合成牛奶2 40 盒'],
  ['64g', '合成存储卡64GB'],
  ['64g', '合成存储卡64 GB'],
  ['64g', '合成存储卡6 4GB'],
])('数字边界与拉丁单位边界：规格 %s 不匹配标题 %s', (spec, title) => {
  expect(findSpecInTitle(spec, title)).toBeNull();
});

it('「124盒」「240盒」「64GB」各自按完整写法读出', () => {
  expect(normalizeSpec('124盒')).toEqual([{ value: '124', unit: '盒' }]);
  expect(normalizeSpec('2 40盒')).toEqual([{ value: '240', unit: '盒' }]);
  expect(normalizeSpec('64GB')).toBeNull();
  expect(normalizeSpec('64 GB')).toBeNull();
});

it('拉丁单位之后原文有空白时算词边界', () => {
  expect(findSpecInTitle('500g', '合成谷物500g x2')).toBe('500g');
  expect(findSpecInTitle('1kg', '合成谷物1kg Pack')).toBe('1kg');
  expect(findSpecInTitle('500g', '合成谷物500gx2')).toBeNull();
});

it.each([
  ['5升', '合成饮用水二点五升'],
  ['5升', '合成饮用水2.5升'],
  ['5升', '合成饮用水2点5升'],
  ['5升', '合成饮用水2 . 5升'],
  ['2升', '合成饮用水二点五升'],
  ['2升', '合成饮用水2.5升'],
  ['25升', '合成饮用水2.5升'],
  ['25升', '合成饮用水二点五升'],
  ['2.5升', '合成饮用水25升'],
  ['2.5升', '合成饮用水2升'],
  ['2.5升', '合成饮用水5升'],
  ['二点五升', '合成饮用水25升'],
  ['2.5升', '合成饮用水2.5毫升'],
  ['2.5升', '合成饮用水2.5千克'],
  ['5升', '合成饮用水二点五十升'],
  ['10升', '合成饮用水二点五十升'],
  ['5升', '合成饮用水二点两升'],
  ['2升', '合成饮用水二点两升'],
  ['1升', '合成饮用水2.5.1升'],
  ['5升', '合成饮用水2.5.1升'],
  ['1升', '合成饮用水二点五点一升'],
])('小数按完整数值比较，不截断、不取尾部：规格 %s 不匹配标题 %s', (spec, title) => {
  expect(findSpecInTitle(spec, title)).toBeNull();
});

it.each([
  ['2.5升', '合成饮用水二点五升', '二点五升'],
  ['二点五升', '合成饮用水2.5升', '2.5升'],
  ['2.5L', '合成饮用水2点5升', '2点5升'],
  ['2.5升', '合成饮用水2.50L', '2.50L'],
  ['0.5kg', '合成谷物零点五千克', '零点五千克'],
  ['1.25L', '合成饮品一点二五升', '一点二五升'],
  ['2升', '合成饮用水2.0升', '2.0升'],
  ['2.5升', '统一 二点五升饮用水', '二点五升'],
])('小数规格一致：规格 %s 与标题 %s → %s', (spec, title, fragment) => {
  expect(findSpecInTitle(spec, title)).toBe(fragment);
});

it('小数规格归一为十进制字符串', () => {
  expect(normalizeSpec('二点五升')).toEqual([{ value: '2.5', unit: 'L' }]);
  expect(normalizeSpec('2.5升')).toEqual([{ value: '2.5', unit: 'L' }]);
  expect(normalizeSpec('2点5 升')).toEqual([{ value: '2.5', unit: 'L' }]);
  expect(normalizeSpec('零点五千克')).toEqual([{ value: '0.5', unit: 'kg' }]);
  expect(normalizeSpec('二点五十升')).toBeNull();
  expect(normalizeSpec('2.5.1升')).toBeNull();
});

it('「点」后没有数字时不当小数点', () => {
  expect(findSpecInTitle('24盒', '合成牛奶一点点24盒')).toBe('24盒');
  expect(findSpecInTitle('2升', '合成饮品8点2升')).toBeNull();
});
