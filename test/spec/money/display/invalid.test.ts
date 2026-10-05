import { formatYuan, formatYuanAdmin, formatYuanRange, InvalidAmount } from '@couli/money';
import { expect, it } from 'vitest';

// Runtime callers can bypass TypeScript. No coercion, even for safe numbers or numeric strings.
const invalidAmounts: { label: string; value: unknown }[] = [
  { label: 'number zero', value: 0 },
  { label: 'number integer', value: 600 },
  { label: 'number fraction', value: 0.01 },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: 'negative Infinity', value: -Infinity },
  { label: 'numeric string', value: '600' },
  { label: 'empty string', value: '' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'boolean', value: true },
  { label: 'object', value: {} },
  { label: 'array', value: [600n] },
  { label: 'symbol', value: Symbol('fen') },
  { label: 'coercible object', value: { valueOf: () => 600n } },
  { label: 'below int64', value: -9223372036854775809n },
  { label: 'above int64', value: 9223372036854775808n },
];

it.each(invalidAmounts)(
  '[AC-F1-06d#8][BR-TEXT-10] App 非法分值 $label 抛 InvalidAmount',
  ({ value }) => {
    expect(() => formatYuan(value as bigint)).toThrow(InvalidAmount);
  },
);

it.each(invalidAmounts)(
  '[AC-F1-06d#9][BR-TEXT-10] 后台非法分值 $label 抛 InvalidAmount',
  ({ value }) => {
    expect(() => formatYuanAdmin(value as bigint, { signed: true })).toThrow(InvalidAmount);
  },
);

it.each(invalidAmounts)(
  '[AC-F1-06d#10][BR-TEXT-10] 区间任一端非法 $label 均抛 InvalidAmount',
  ({ value }) => {
    const bad = value as bigint;
    // Equal invalid endpoints must be rejected before any equality/zero short circuit.
    for (const opts of [undefined, { admin: true }]) {
      expect(() => formatYuanRange(bad, 1n, opts)).toThrow(InvalidAmount);
      expect(() => formatYuanRange(0n, bad, opts)).toThrow(InvalidAmount);
      expect(() => formatYuanRange(bad, bad, opts)).toThrow(InvalidAmount);
    }
  },
);

it.each([
  [450n, 320n],
  [1n, 0n],
  [-1n, 1n],
  [-1n, 0n],
  [0n, -1n],
  [-2n, -1n],
  [-1n, -1n],
  [-9223372036854775808n, 9223372036854775807n],
] as const)('[AC-F1-06d#11][BR-TEXT-10] 返利区间拒绝负数或倒序 %s / %s', (min, max) => {
  expect(() => formatYuanRange(min, max)).toThrow(InvalidAmount);
  expect(() => formatYuanRange(min, max, { admin: true })).toThrow(InvalidAmount);
});
