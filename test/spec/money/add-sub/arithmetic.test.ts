import { InvalidAmount } from '@couli/money';
import { expect, it } from 'vitest';
import { addFen, subFen } from './subject.ts';

const MIN = -9223372036854775808n;
const MAX = 9223372036854775807n;

// Local AC-B2-01b labels identify this task's checks, not a new business acceptance rule.
it.each([
  { label: '零', left: 0n, right: 0n, expected: 0n },
  { label: '一分进位', left: 99n, right: 1n, expected: 100n },
  { label: '正金额', left: 12345n, right: 678n, expected: 13023n },
  { label: '负金额', left: -12345n, right: -678n, expected: -13023n },
  { label: '异号正结果', left: 120n, right: -20n, expected: 100n },
  { label: '异号负结果', left: -120n, right: 20n, expected: -100n },
  { label: '相消', left: 123n, right: -123n, expected: 0n },
  {
    label: '超过 2^53 保留奇数分',
    left: 9007199254740992n,
    right: 1n,
    expected: 9007199254740993n,
  },
  { label: '大数负金额', left: -9007199254740992n, right: -1n, expected: -9007199254740993n },
  { label: '上界', left: MAX - 1n, right: 1n, expected: MAX },
  { label: '下界', left: MIN + 1n, right: -1n, expected: MIN },
  { label: '上界加零', left: MAX, right: 0n, expected: MAX },
  { label: '下界加零', left: MIN, right: 0n, expected: MIN },
  { label: '两端相加', left: MIN, right: MAX, expected: -1n },
])('[AC-B2-01b#1][BR-CALC-01] addFen $label 精确返回 bigint 分', ({ left, right, expected }) => {
  expect(addFen(left, right)).toBe(expected);
  expect(addFen(right, left)).toBe(expected);
});

it.each([
  { label: '零', left: 0n, right: 0n, expected: 0n },
  { label: '借一分', left: 100n, right: 1n, expected: 99n },
  { label: '返后价', left: 12900n, right: 350n, expected: 12550n },
  { label: '相等', left: 350n, right: 350n, expected: 0n },
  { label: '默认允许负结果', left: 1n, right: 2n, expected: -1n },
  { label: '零减正数', left: 0n, right: 1n, expected: -1n },
  { label: '减去负数', left: 100n, right: -1n, expected: 101n },
  { label: '负数减正数', left: -100n, right: 1n, expected: -101n },
  { label: '负数减负数正结果', left: -100n, right: -101n, expected: 1n },
  { label: '负数减负数负结果', left: -101n, right: -100n, expected: -1n },
  { label: '大数保留一分差', left: 9007199254740993n, right: 9007199254740992n, expected: 1n },
  { label: '大数结果', left: 9007199254740994n, right: 1n, expected: 9007199254740993n },
  { label: '上界', left: MAX - 1n, right: -1n, expected: MAX },
  { label: '下界', left: MIN + 1n, right: 1n, expected: MIN },
  { label: '上界减零', left: MAX, right: 0n, expected: MAX },
  { label: '下界减零', left: MIN, right: 0n, expected: MIN },
  { label: '下界相减无需先取负', left: MIN, right: MIN, expected: 0n },
  { label: '上界相减', left: MAX, right: MAX, expected: 0n },
])('[AC-B2-01b#2][BR-CALC-01][BR-PRICE-09] subFen $label', ({ left, right, expected }) => {
  expect(subFen(left, right)).toBe(expected);
  expect(subFen(left, right, undefined)).toBe(expected);
  expect(subFen(left, right, {})).toBe(expected);
  expect(subFen(left, right, { nonNegative: false })).toBe(expected);
});

it.each([
  { label: '正返后价', left: 12900n, right: 350n, expected: 12550n },
  { label: '零', left: 0n, right: 0n, expected: 0n },
  { label: '相等', left: 350n, right: 350n, expected: 0n },
  { label: '负入参但正结果', left: -1n, right: -2n, expected: 1n },
  { label: '负入参但零结果', left: MIN, right: MIN, expected: 0n },
  { label: '减负数到上界', left: MAX - 1n, right: -1n, expected: MAX },
])('[AC-B2-01b#3][BR-CALC-01] 非负检查只约束结果：$label', ({ left, right, expected }) => {
  const options = Object.freeze({ nonNegative: true });
  expect(subFen(left, right, options)).toBe(expected);
  expect(options).toEqual({ nonNegative: true });
});

it.each([
  { label: '差一分', left: 1n, right: 2n },
  { label: '零减一分', left: 0n, right: 1n },
  { label: '两个负入参', left: -2n, right: -1n },
  { label: '负入参减零', left: MIN, right: 0n },
])('[AC-B2-01b#4][BR-CALC-01] 非负检查对负结果抛 InvalidAmount：$label', ({ left, right }) => {
  expect(() => subFen(left, right, { nonNegative: true })).toThrow(InvalidAmount);
});
