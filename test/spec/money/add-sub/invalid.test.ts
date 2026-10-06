import { InvalidAmount } from '@couli/money';
import { expect, it } from 'vitest';
import { addFen, subFen } from './subject.ts';

const MIN = -9223372036854775808n;
const MAX = 9223372036854775807n;

const invalidAmounts: { label: string; value: unknown }[] = [
  { label: 'number 零', value: 0 },
  { label: 'number 整数', value: 100 },
  { label: 'number 小数', value: 0.01 },
  { label: 'number 不安全整数', value: Number.MAX_SAFE_INTEGER + 1 },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: '负 Infinity', value: -Infinity },
  { label: '数字字符串', value: '100' },
  { label: '空串', value: '' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'true', value: true },
  { label: 'false', value: false },
  { label: '对象', value: {} },
  { label: '数组', value: [1n] },
  { label: 'symbol', value: Symbol('fen') },
  { label: '可强转对象', value: { valueOf: () => 1n } },
  { label: '低于 int64', value: MIN - 1n },
  { label: '高于 int64', value: MAX + 1n },
  { label: '极大 bigint', value: 1n << 128n },
  { label: '极小 bigint', value: -(1n << 128n) },
];

it.each(invalidAmounts)(
  '[AC-B2-01b#5][BR-CALC-01] addFen 拒绝任一非法入参：$label',
  ({ value }) => {
    const bad = value as bigint;
    expect(() => addFen(bad, 0n)).toThrow(InvalidAmount);
    expect(() => addFen(0n, bad)).toThrow(InvalidAmount);
    expect(() => addFen(bad, bad)).toThrow(InvalidAmount);
  },
);

it.each(invalidAmounts)(
  '[AC-B2-01b#6][BR-CALC-01] subFen 拒绝任一非法入参：$label',
  ({ value }) => {
    const bad = value as bigint;
    for (const options of [undefined, {}, { nonNegative: false }, { nonNegative: true }]) {
      expect(() => subFen(bad, 0n, options)).toThrow(InvalidAmount);
      expect(() => subFen(0n, bad, options)).toThrow(InvalidAmount);
      expect(() => subFen(bad, bad, options)).toThrow(InvalidAmount);
    }
  },
);

it.each([
  { label: '上界外加负一', left: MAX + 1n, right: -1n },
  { label: '下界外加一', left: MIN - 1n, right: 1n },
  { label: '越界数相消', left: MAX + 1n, right: -(MAX + 1n) },
])('[AC-B2-01b#7][BR-CALC-01] 和在范围内仍拒绝越界入参：$label', ({ left, right }) => {
  expect(() => addFen(left, right)).toThrow(InvalidAmount);
  expect(() => addFen(right, left)).toThrow(InvalidAmount);
});

it.each([
  { label: '上界外减一', left: MAX + 1n, right: 1n },
  { label: '下界外减负一', left: MIN - 1n, right: -1n },
  { label: '越界减数抵消', left: MAX, right: MAX + 1n },
  { label: '越界负减数抵消', left: MIN, right: MIN - 1n },
])('[AC-B2-01b#8][BR-CALC-01] 差在范围内仍拒绝越界入参：$label', ({ left, right }) => {
  expect(() => subFen(left, right)).toThrow(InvalidAmount);
  expect(() => subFen(left, right, { nonNegative: true })).toThrow(InvalidAmount);
});

it.each([
  { label: '上溢一分', left: MAX, right: 1n },
  { label: '下溢一分', left: MIN, right: -1n },
  { label: '两上界', left: MAX, right: MAX },
  { label: '两下界', left: MIN, right: MIN },
])('[AC-B2-01b#9][BR-CALC-01] addFen 拒绝结果越界：$label', ({ left, right }) => {
  expect(() => addFen(left, right)).toThrow(InvalidAmount);
  expect(() => addFen(right, left)).toThrow(InvalidAmount);
});

it.each([
  { label: '上溢一分', left: MAX, right: -1n },
  { label: '下溢一分', left: MIN, right: 1n },
  { label: '零减下界', left: 0n, right: MIN },
  { label: '最大正差', left: MAX, right: MIN },
  { label: '最大负差', left: MIN, right: MAX },
])('[AC-B2-01b#10][BR-CALC-01] subFen 无论非负选项都拒绝结果越界：$label', ({ left, right }) => {
  expect(() => subFen(left, right)).toThrow(InvalidAmount);
  expect(() => subFen(left, right, { nonNegative: false })).toThrow(InvalidAmount);
  expect(() => subFen(left, right, { nonNegative: true })).toThrow(InvalidAmount);
});
