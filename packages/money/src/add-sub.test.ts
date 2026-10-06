import { expect, it } from 'vitest';
import * as impl from './add-sub.ts';
import { addFen, InvalidAmount, subFen } from './index.ts';

const MIN = -9223372036854775808n;
const MAX = 9223372036854775807n;

it('[AC-B2-01b#u1] index exports the implementation functions by reference', () => {
  expect(addFen).toBe(impl.addFen);
  expect(subFen).toBe(impl.subFen);
});

it('[AC-B2-01b#u2] net price subtraction stays exact beyond 2^53', () => {
  expect(subFen(9007199254740993n, 1n, { nonNegative: true })).toBe(9007199254740992n);
  expect(addFen(MAX, MIN)).toBe(-1n);
});

it('[AC-B2-01b#u3] an invalid operand is reported before an invalid option', () => {
  const badOptions = { nonNegative: 'yes' } as unknown as { nonNegative: boolean };
  expect(() => subFen(1 as unknown as bigint, 0n, badOptions)).toThrow(InvalidAmount);
});

it.each([
  { label: 'string flag', options: { nonNegative: 'true' } },
  { label: 'number flag', options: { nonNegative: 1 } },
  { label: 'null options', options: null },
  { label: 'boolean options', options: true },
])('[AC-B2-01b#u4] subFen rejects a malformed option: $label', ({ options }) => {
  const bad = options as unknown as { nonNegative?: boolean };
  expect(() => subFen(1n, 2n, bad)).toThrow(TypeError);
});

it('[AC-B2-01b#u5] overflow and negative-result errors are InvalidAmount', () => {
  expect(() => addFen(MAX, 1n)).toThrow(InvalidAmount);
  expect(() => subFen(MIN, 1n)).toThrow(InvalidAmount);
  expect(() => subFen(0n, 1n, { nonNegative: true })).toThrow(InvalidAmount);
});
