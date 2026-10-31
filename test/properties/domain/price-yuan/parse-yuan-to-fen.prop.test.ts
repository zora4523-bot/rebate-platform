import { parseYuanToFen } from '@couli/domain';
import { createPropStats, propParams, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { expectedFen, INT64_MAX, parseUnknown } from '../../../spec/domain/price-yuan/kit.ts';

// Every property calls parseYuanToFen directly: anything it throws fails the property as it is,
// which is how "never throws" is shown. Properties return a boolean; the one summary assertion
// outside fc.assert checks that every run was counted.

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const digitString = (minLength: number, maxLength: number) =>
  fc.string({ unit: fc.constantFrom(...DIGITS), minLength, maxLength });
const pad2 = (value: number) => String(value).padStart(2, '0');
const yuanOf = (fen: bigint) => `${fen / 100n}.${pad2(Number(fen % 100n))}`;

/** Asserts the property `build` makes; returns the number of runs its stats counted. */
function countedRuns<Ts>(name: string, build: (stats: PropStats) => fc.IProperty<Ts>): number {
  const stats = createPropStats(name);
  try {
    fc.assert(build(stats), propParams());
  } catch (error) {
    // Keep the stats file, then rethrow the failure untouched (its cause stays the skeleton's).
    stats.flush();
    throw error;
  }
  const { hits } = stats.flush();
  return Object.values(hits).reduce((sum, count) => sum + count, 0);
}

it('[AC-B1-04zi#15] [BR-PRICE-01] 属性：非负整数 a 与 0–99 的 b，整数 / 一位 / 两位小数（可带前导 0）精确换算', () => {
  expect(
    countedRuns('price-yuan:exact', (stats) =>
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom('integer', 'one-decimal', 'two-decimals'),
        (a, b, leadingZeros, shape) => {
          stats.hit(`${shape}/${leadingZeros > 0 ? 'leading-zero' : 'plain'}`);
          const whole = `${'0'.repeat(leadingZeros)}${a}`;
          const tenths = Math.floor(b / 10);
          const [text, fen]: readonly [string, bigint] =
            shape === 'integer'
              ? [whole, a * 100n]
              : shape === 'one-decimal'
                ? [`${whole}.${tenths}`, a * 100n + BigInt(tenths) * 10n]
                : [`${whole}.${pad2(b)}`, a * 100n + BigInt(b)];
          return parseYuanToFen(text) === fen;
        },
      ),
    ),
  ).toBe(propParams().numRuns);
});

it('[AC-B1-04zi#16] [BR-PRICE-01] 属性：至少三位小数的数字串一律缺失（含末尾全为 0），不抛异常', () => {
  expect(
    countedRuns('price-yuan:over-two-decimals', (stats) =>
      fc.property(
        digitString(1, 20),
        fc.oneof(
          digitString(3, 30),
          fc
            .tuple(digitString(0, 2), fc.integer({ min: 1, max: 10 }))
            .map(([head, zeros]) => `${head.padEnd(2, '0')}${'0'.repeat(zeros)}`),
        ),
        (whole, fraction) => {
          stats.hit(/^0+$/.test(fraction.slice(2)) ? 'zero-tail' : 'nonzero-tail');
          return parseYuanToFen(`${whole}.${fraction}`) === null;
        },
      ),
    ),
  ).toBe(propParams().numRuns);
});

it('[AC-B1-04zi#17] [BR-PRICE-01] 属性：int64 上界附近，两位小数串不超界时等于分值，超界即缺失', () => {
  expect(
    countedRuns('price-yuan:int64-boundary', (stats) =>
      fc.property(fc.bigInt({ min: INT64_MAX - 100_000n, max: INT64_MAX + 100_000n }), (fen) => {
        stats.hit(fen > INT64_MAX ? 'above' : 'within');
        return parseYuanToFen(yuanOf(fen)) === (fen > INT64_MAX ? null : fen);
      }),
    ),
  ).toBe(propParams().numRuns);
});

it('[AC-B1-04zi#18] [BR-PRICE-01] 属性：任意字符串只返回 null 或非负 bigint，与正则口径一致、不抛异常且结果确定', () => {
  const nearMiss = fc.string({
    unit: fc.constantFrom(
      ...DIGITS,
      '.',
      '.',
      '-',
      '+',
      'e',
      'E',
      'x',
      ' ',
      '\t',
      '\n',
      ',',
      '_',
      ' ',
      '１',
      '٣',
    ),
    maxLength: 24,
  });
  expect(
    countedRuns('price-yuan:any-string', (stats) =>
      fc.property(
        fc.oneof(
          nearMiss,
          fc.string({ unit: 'binary', maxLength: 32 }),
          fc.string({ unit: 'grapheme', maxLength: 16 }),
        ),
        (text) => {
          const expected = expectedFen(text);
          stats.hit(expected === null ? 'null' : 'fen');
          const first = parseYuanToFen(text);
          const second = parseYuanToFen(text);
          const shapeOk = first === null || (typeof first === 'bigint' && first >= 0n);
          return shapeOk && first === expected && second === first;
        },
      ),
    ),
  ).toBe(propParams().numRuns);
});

it('[AC-B1-04zi#19] [BR-PRICE-01] 属性：任意非字符串输入返回 null 且不抛异常', () => {
  expect(
    countedRuns('price-yuan:non-string', (stats) =>
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.bigInt(),
          fc.boolean(),
          fc.constantFrom(null, undefined),
          fc.array(fc.string({ unit: fc.constantFrom(...DIGITS, '.') }), { maxLength: 3 }),
          fc.object(),
          fc.anything().filter((value) => typeof value !== 'string'),
        ),
        (value) => {
          stats.hit(Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
          return parseUnknown(value) === null;
        },
      ),
    ),
  ).toBe(propParams().numRuns);
});
