import { expect, it } from 'vitest';
import {
  applyReserve,
  InvalidAmount,
  InvalidRatio,
  mulDivCeil,
  mulDivFloor,
  parseFen,
  pctStrToBp,
  splitByBp,
  yuanStrToFen,
} from './index.ts';

it('[AC-B2-01a#1] decimal parser distinguishes negative tails from trailing zeros', () => {
  expect(['-0.001', '-3.201', '-3.2000', '-0.000', '0.009'].map(yuanStrToFen)).toEqual([
    -1n,
    -321n,
    -320n,
    0n,
    0n,
  ]);
});

it.each(['1\n', '1\r\n', ' 1', '1 ', '+1', '１', '.1', '1.'])(
  '[AC-B2-01a#2] parsers reject an incomplete or decorated literal: %s',
  (text) => {
    expect(() => parseFen(text)).toThrow(InvalidAmount);
    expect(() => yuanStrToFen(text)).toThrow(InvalidAmount);
    expect(() => pctStrToBp(text)).toThrow(InvalidRatio);
  },
);

it('[AC-B2-01a#3] percentage parser preserves precision and accepts exact endpoints', () => {
  expect(['0', '-0.000', '20.00', '12.345', '99.999', '100.000'].map(pctStrToBp)).toEqual([
    0n,
    0n,
    2000n,
    1234n,
    9999n,
    10000n,
  ]);
});

it.each(['-0.001', '-1', '100.0001', '101', '', '1e1', 'NaN', '20%'])(
  '[AC-B2-01a#4] percentage parser rejects invalid raw input: %s',
  (text) => {
    expect(() => pctStrToBp(text)).toThrow(InvalidRatio);
  },
);

it('[AC-B2-01a#5] ceil handles exact, inexact and zero products with bigint precision', () => {
  expect([
    mulDivCeil(1n, 1n, 3n),
    mulDivCeil(6n, 1n, 3n),
    mulDivCeil(0n, 10000n, 10000n),
    mulDivCeil(123n, 0n, 10000n),
    mulDivCeil(9007199254740993n, 5000n, 10000n),
    mulDivFloor(1n, 1n, 3n),
  ]).toEqual([1n, 2n, 0n, 0n, 4503599627370497n, 0n]);
});

it.each([0n, -1n, 10000, '10000', null, undefined])(
  '[AC-B2-01a#6] floor and ceil reject invalid denominators even for zero amounts: %s',
  (denominator) => {
    expect(() => mulDivFloor(0n, 0n, denominator as bigint)).toThrow(InvalidRatio);
    expect(() => mulDivCeil(0n, 0n, denominator as bigint)).toThrow(InvalidRatio);
  },
);

it('[AC-B2-01a#7] runtime validation remains active for ceil and zero or negative bases', () => {
  expect(() => mulDivCeil(-1n, 0n, 10000n)).toThrow(InvalidAmount);
  expect(() => mulDivCeil(1 as unknown as bigint, 0n, 10000n)).toThrow(InvalidAmount);
  expect(() => mulDivCeil(0n, 10001n, 10000n)).toThrow(InvalidRatio);
  expect(() => mulDivCeil(0n, 1 as unknown as bigint, 10000n)).toThrow(InvalidRatio);
  expect(() => pctStrToBp(20 as unknown as string)).toThrow(InvalidRatio);
  expect(() => applyReserve(-1n, 10001n)).toThrow(InvalidRatio);
  expect(() => splitByBp(0n, [5001n, 5000n])).toThrow(InvalidRatio);
  expect(() => splitByBp(0n, new Array<bigint>(1))).toThrow(InvalidRatio);
  expect(() => splitByBp(0n, null as unknown as bigint[])).toThrow(InvalidRatio);
});

it('[AC-B2-01a#8] bigint inputs cannot bypass the parsed amount storage bounds', () => {
  expect([parseFen(-9223372036854775808n), parseFen(9223372036854775807n)]).toEqual([
    -9223372036854775808n,
    9223372036854775807n,
  ]);
  expect(() => parseFen(-9223372036854775809n)).toThrow(InvalidAmount);
  expect(() => parseFen(9223372036854775808n)).toThrow(InvalidAmount);
});

it('[AC-B2-01a#9] storage bounds apply to the rounded fen, including boundary tails', () => {
  expect(
    ['92233720368547758.079', '-92233720368547758.0800', '-92233720368547758.079'].map(
      yuanStrToFen,
    ),
  ).toEqual([9223372036854775807n, -9223372036854775808n, -9223372036854775808n]);
  expect(() => yuanStrToFen('-92233720368547758.0801')).toThrow(InvalidAmount);
});
