import { InvalidAmount, InvalidRatio, mulBpBpFloor } from '@couli/money';
import { expect, it } from 'vitest';

// Deliberately cross the TS boundary to check runtime validation, without coercing inputs.
const nonBigints: { label: string; value: unknown }[] = [
  { label: 'number 零', value: 0 },
  { label: 'number 整数', value: 7500 },
  { label: 'number 小数', value: 0.5 },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: '负 Infinity', value: -Infinity },
  { label: '数字字符串', value: '7500' },
  { label: '空串', value: '' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'true', value: true },
  { label: 'false', value: false },
  { label: '普通对象', value: {} },
  { label: '数组', value: [7500n] },
  { label: 'symbol', value: Symbol('bp') },
  { label: '可强转对象', value: { valueOf: () => 7500n } },
];

it.each([
  ...nonBigints,
  { label: '负一分', value: -1n },
  { label: '负金额', value: -101n },
  { label: 'int64 最小负金额', value: -9223372036854775808n },
])('[AC-B2-01c#3][BR-CALC-01] 金额非法抛 InvalidAmount：$label', ({ value }) => {
  const bad = value as bigint;
  expect(() => mulBpBpFloor(bad, 7500n, 8000n)).toThrow(InvalidAmount);
  expect(() => mulBpBpFloor(bad, 0n, 10000n)).toThrow(InvalidAmount);
  expect(() => mulBpBpFloor(bad, 10000n, 0n)).toThrow(InvalidAmount);
});

const invalidRatios = [
  ...nonBigints,
  { label: '负一 bp', value: -1n },
  { label: '超过上界一 bp', value: 10001n },
  { label: '将两比例乘积误作单个比例', value: 75000000n },
];

it.each(invalidRatios)(
  '[AC-B2-01c#4][BR-CALC-01] 首比例非法抛 InvalidRatio，零值不能绕过：$label',
  ({ value }) => {
    const bad = value as bigint;
    expect(() => mulBpBpFloor(333n, bad, 8000n)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(0n, bad, 8000n)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(333n, bad, 0n)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(0n, bad, 0n)).toThrow(InvalidRatio);
  },
);

it.each(invalidRatios)(
  '[AC-B2-01c#5][BR-CALC-01] 次比例非法抛 InvalidRatio，零值不能绕过：$label',
  ({ value }) => {
    const bad = value as bigint;
    expect(() => mulBpBpFloor(333n, 7500n, bad)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(0n, 7500n, bad)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(333n, 0n, bad)).toThrow(InvalidRatio);
    expect(() => mulBpBpFloor(0n, 0n, bad)).toThrow(InvalidRatio);
  },
);
