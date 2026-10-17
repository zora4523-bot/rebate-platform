import { isInviteCodeFormat, normalizeInviteCode } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  [' ｋ７ｍ２ｑｘ\u200b ', 'K7M2QX'],
  ['k7m2qx', 'K7M2QX'],
  ['Ｋ７Ｍ２ＱＸ', 'K7M2QX'],
  ['ⓚ⑦ｍ²ｑｘ', 'K7M2QX'],
  ['', ''],
  ['\u3000', ''],
  [' \t\n\u200b\u200c\u200d\ufeff', ''],
  ['o0i1', 'O0I1'],
  ['ß', 'SS'],
  // NFKC 在删除零宽字符之前：此时 a 和组合圆圈尚不相邻。
  ['a\u200b\u030a', 'A\u030a'],
  ['K7\u2060M2QX', 'K7\u2060M2QX'],
])('[AC-B1-11c#1] BR-INV-02 依次规范化 %j → %j，不做纠错或渠道判断', (raw, expected) => {
  expect(normalizeInviteCode(raw)).toBe(expected);
});

// Unicode White_Space 全集，另含 JS \s 的 FEFF 和明确规定的零宽字符。
it.each([
  '\u0009',
  '\u000a',
  '\u000b',
  '\u000c',
  '\u000d',
  '\u0020',
  '\u0085',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\u200b',
  '\u200c',
  '\u200d',
  '\ufeff',
])('[AC-B1-11c#2] BR-INV-02 删除首尾和内部的全部规定空白 %j', (space) => {
  expect(normalizeInviteCode(`${space}k${space}7${space}m2qx${space}`)).toBe('K7M2QX');
});

it.each(['K7M2QX', '234567', '89ABCD', 'EFGHJK', 'LMNPQR', 'STUVWX', 'YZ2345', '222222'])(
  '[AC-B1-11c#3] BR-INV-01 接受六位合法字符 %s（含 L）',
  (code) => {
    expect(isInviteCodeFormat(code)).toBe(true);
  },
);

it.each([
  '',
  'K7M2Q',
  'K7M2QXX',
  '07M2QX',
  'O7M2QX',
  '17M2QX',
  'I7M2QX',
  'k7m2qx',
  'Ｋ７Ｍ２ＱＸ',
  ' K7M2QX',
  'K7M2QX ',
  'K7M2QX\n',
  'K7M2QX\r\n',
  'K7 M2Q',
  'K7\u200bM2QX',
  'K7-M2Q',
  'K7_M2Q',
  'K7中2QX',
  'K7😀2QX',
])('[AC-B1-11c#4] BR-INV-02 格式检查独立于规范化，拒绝 %j', (code) => {
  expect(isInviteCodeFormat(code)).toBe(false);
});
