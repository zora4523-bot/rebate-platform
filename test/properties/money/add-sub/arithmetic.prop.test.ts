import { InvalidAmount } from '@couli/money';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { addFen, subFen } from '../../../spec/money/add-sub/subject.ts';

const MIN = -9223372036854775808n;
const MAX = 9223372036854775807n;
const signedFen = fc.oneof(
  fc.bigInt({ min: MIN, max: MAX }),
  fc.constantFrom(
    MIN,
    MIN + 1n,
    -9007199254740993n,
    -1n,
    0n,
    1n,
    9007199254740991n,
    9007199254740992n,
    9007199254740993n,
    MAX - 1n,
    MAX,
  ),
);

it.each([
  { label: 'addFen', operation: addFen, subtract: false },
  { label: 'subFen', operation: subFen, subtract: true },
])(
  '[AC-B2-01b#11][BR-CALC-01] $label 全 int64 范围精确运算或拒绝结果溢出',
  ({ label, operation, subtract }) => {
    const params = propParams();
    const stats = createPropStats(`money:add-sub:${label}:int64`);
    fc.assert(
      fc.property(signedFen, signedFen, (left, right) => {
        // The independent bigint oracle never passes through a JS number.
        const expected = subtract ? left - right : left + right;
        const overflow = expected < MIN || expected > MAX;
        stats.hit(
          overflow
            ? 'overflow'
            : expected < 0n
              ? 'negative'
              : expected === 0n
                ? 'zero'
                : 'positive',
        );
        if (overflow) {
          expect(() => operation(left, right)).toThrow(InvalidAmount);
        } else {
          expect(operation(left, right)).toBe(expected);
        }
        return true;
      }),
      params,
    );
    const record = stats.flush();
    expect({
      count: Object.values(record.hits).reduce((total, count) => total + count, 0),
      discards: record.discards,
    }).toEqual({ count: params.numRuns, discards: 0 });
  },
  120_000,
);

it('[AC-B2-01b#12][BR-CALC-01] subFen 非负选项恰好接受 int64 范围内非负差值', () => {
  const params = propParams();
  const stats = createPropStats('money:add-sub:non-negative');
  fc.assert(
    fc.property(signedFen, signedFen, (left, right) => {
      const expected = left - right;
      stats.hit(expected < 0n ? 'negative' : expected > MAX ? 'overflow' : 'accepted');
      if (expected < 0n || expected > MAX) {
        expect(() => subFen(left, right, { nonNegative: true })).toThrow(InvalidAmount);
      } else {
        expect(subFen(left, right, { nonNegative: true })).toBe(expected);
      }
      return true;
    }),
    params,
  );
  const record = stats.flush();
  expect({
    count: Object.values(record.hits).reduce((total, count) => total + count, 0),
    discards: record.discards,
  }).toEqual({ count: params.numRuns, discards: 0 });
}, 120_000);

it('[AC-B2-01b#13][BR-CALC-01] 不溢出时加减互逆、加法交换且减零不变', () => {
  const params = propParams();
  const stats = createPropStats('money:add-sub:inverse');
  // Both operands and their sum fit int64 without discarding generated examples.
  const halfRange = fc.bigInt({ min: MIN / 2n, max: MAX / 2n });
  fc.assert(
    fc.property(halfRange, halfRange, (left, right) => {
      stats.hit(left < 0n ? 'negative-left' : 'non-negative-left');
      const sum = addFen(left, right);
      expect(addFen(right, left)).toBe(sum);
      expect(subFen(sum, right)).toBe(left);
      expect(subFen(sum, left)).toBe(right);
      expect(subFen(left, 0n)).toBe(left);
      return true;
    }),
    params,
  );
  const record = stats.flush();
  expect({
    count: Object.values(record.hits).reduce((total, count) => total + count, 0),
    discards: record.discards,
  }).toEqual({ count: params.numRuns, discards: 0 });
}, 120_000);
