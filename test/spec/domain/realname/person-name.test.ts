import { normalizePersonName, samePersonName } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  ['阿依古丽•买买提', '阿依古丽·买买提'],
  ['阿依古丽.买买提', '阿依古丽·买买提'],
  ['阿依古丽．买买提', '阿依古丽·买买提'],
  ['阿依古丽・买买提', '阿依古丽·买买提'],
  ['甲•乙.丙．丁・戊·己', '甲·乙·丙·丁·戊·己'],
  ['\u00a0\u3000 阿依古丽·买买提 \u3000\u00a0', '阿依古丽·买买提'],
  ['\t\r\n\u2003王明\u2003\n\r\t', '王明'],
  [' Ａｌｉｃｅ Ａ ', 'Alice A'],
  ['Ａ\u3000Ｂ\u00a0Ｃ', 'A B C'],
  ['e\u0301', 'é'],
  ['甲  乙', '甲  乙'],
  ['甲\t乙', '甲\t乙'],
  ['甲\n乙', '甲\n乙'],
  ['\u200b甲\u200b', '\u200b甲\u200b'],
  ['', ''],
  [' \t\r\n\u3000\u00a0', ''],
])('[AC-B1-13c#14] 姓名按 NFKC、trim、间隔符替换的顺序规范化：%j', (input, expected) => {
  expect(normalizePersonName(input)).toBe(expected);
});

it.each([
  ['阿依古丽•买买提', '阿依古丽·买买提\u3000', true],
  [' Ａｌｉｃｅ ', 'Alice', true],
  ['é', 'e\u0301', true],
  [' ', '\u3000', true],
  ['张三', '张四', false],
  ['张 三', '张三', false],
  ['张  三', '张 三', false],
  ['Alice', 'alice', false],
  ['張三', '张三', false],
  ['甲∙乙', '甲·乙', false],
  ['\u200b张三', '张三', false],
] as const)('[AC-B1-13c#15] 双方规范化后逐码点比较 %j 与 %j', (a, b, expected) => {
  expect(samePersonName(a, b)).toBe(expected);
  expect(samePersonName(b, a)).toBe(expected);
});
