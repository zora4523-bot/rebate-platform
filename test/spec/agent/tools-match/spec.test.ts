import { findSpecInTitle, normalizeSpec } from '@couli/domain';
import type { SpecUnit } from '@couli/domain';
import { expect, it } from 'vitest';

// BR-AI-24 细则：只比较规格，不判断品类；返回标题的原文（NFKC、去空白）。
it.each([
  [1, '24盒', '合成牛奶２４盒装', '24盒', '24', '盒'],
  [2, '２４ 盒', '合成牛奶24\t盒装', '24盒', '24', '盒'],
  [3, '24盒', '合成牛奶二十四盒装', '二十四盒', '24', '盒'],
  [4, '二十四盒', '合成牛奶24盒装', '24盒', '24', '盒'],
  [5, '500ml', '合成饮品500毫升装', '500毫升', '500', 'ml'],
  [6, '500毫升', '合成饮品500ml装', '500ml', '500', 'ml'],
  [7, '2L', '合成饮品2升装', '2升', '2', 'L'],
  [8, '2升', '合成饮品2L装', '2L', '2', 'L'],
  [9, '500g', '合成谷物500克装', '500克', '500', 'g'],
  [10, '500克', '合成谷物500g装', '500g', '500', 'g'],
  [11, '2kg', '合成谷物2千克装', '2千克', '2', 'kg'],
  [12, '2千克', '合成谷物2kg装', '2kg', '2', 'kg'],
  [13, '2.5kg', '合成谷物２．５千克装', '2.5千克', '2.5', 'kg'],
] as const)(
  '[AC-B3-04d#%i] 规格 %s 与标题 %s 一致，保留标题片段',
  (_id, spec, title, fragment, value, unit) => {
    expect(findSpecInTitle(spec, title)).toBe(fragment);
    expect(normalizeSpec(spec)).toEqual([{ value, unit }]);
    expect(normalizeSpec(fragment)).toEqual([{ value, unit }]);
  },
);

it.each<readonly [number, string, string]>([
  [14, '24盒', '合成牛奶124盒'],
  [15, '24盒', '合成牛奶240盒'],
  [16, '24盒', '合成牛奶12盒'],
  [17, '24盒', '合成牛奶24箱'],
  [18, '1L', '合成饮品1000ml'],
  [19, '1kg', '合成谷物1000g'],
  [20, '24盒', '合成牛奶12盒×2'],
  [21, '5kg', '合成谷物2.5kg'],
  [22, '24盒', '合成牛奶一百二十四盒'],
  [23, '2g', '合成谷物2kg'],
])('[AC-B3-04d#%i] 规格 %s 不可误匹配 %s', (_id, spec, title) => {
  expect(findSpecInTitle(spec, title)).toBeNull();
});

it('[AC-B3-04d#24] 盒箱袋瓶包件仅匹配原字，不互换', () => {
  const units: readonly SpecUnit[] = ['盒', '箱', '袋', '瓶', '包', '件'];
  for (const unit of units) {
    expect(normalizeSpec(`24${unit}`)).toEqual([{ value: '24', unit }]);
    for (const other of units) {
      expect(findSpecInTitle(`24${unit}`, `合成商品24${other}`)).toBe(
        unit === other ? `24${unit}` : null,
      );
    }
  }
});

it('[AC-B3-04d#25] 多规格必须全部找到，不能只取首个规格或忽略缺失部分', () => {
  expect(normalizeSpec('500ml 24瓶')).toEqual([
    { value: '500', unit: 'ml' },
    { value: '24', unit: '瓶' },
  ]);
  expect(findSpecInTitle('500ml 24瓶', '合成饮品500毫升 24瓶装')).toBe('500毫升24瓶');
  expect(findSpecInTitle('500ml 24瓶', '合成饮品500ml12瓶装')).toBeNull();
  expect(findSpecInTitle('500ml 24瓶', '合成饮品250ml24瓶装')).toBeNull();
  expect(findSpecInTitle('500ml 24瓶', '合成饮品500ml装')).toBeNull();
  expect(findSpecInTitle('500ml 24瓶', '合成饮品24瓶装')).toBeNull();
  expect(findSpecInTitle('500ml 24瓶', '合成饮品24瓶每瓶500ml')).not.toBeNull();
});

it('[AC-B3-04d#26] 没有可识别规格时返回 null，不能以空串视作命中', () => {
  for (const spec of ['', '　 \t', '家庭装', '24']) {
    expect(normalizeSpec(spec)).toBeNull();
    expect(findSpecInTitle(spec, '合成家庭装牛奶24盒')).toBeNull();
  }
  expect(findSpecInTitle('24盒', '')).toBeNull();
});

it('[AC-B3-04d#27] 只核对规格，不把品类或推荐文字写进匹配片段', () => {
  expect(findSpecInTitle('24盒', '合成纸巾24盒优选')).toBe('24盒');
});
