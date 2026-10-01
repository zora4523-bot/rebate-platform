// Harness check only: proves vitest + fast-check + @couli/testing work in this package.
// It contains no money rule. Rule tests live in test/spec and test/properties (规划/11 §4.4).
import { propParams, propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const int64 = fc.bigInt({ min: INT64_MIN, max: INT64_MAX });

it('executes a bigint property exactly propRuns() times', () => {
  let executed = 0;
  fc.assert(
    fc.property(int64, int64, (a, b) => {
      executed += 1;
      return typeof a === 'bigint' && a + b === b + a;
    }),
    propParams(),
  );
  expect(executed).toBe(propRuns());
});

it('generates the same bigint sequence for the same seed and a different one otherwise', () => {
  const draw = (seed: number): bigint[] => fc.sample(int64, { numRuns: 64, seed });
  const first = draw(propSeed());
  expect(first).toHaveLength(64);
  expect(draw(propSeed())).toEqual(first);
  expect(draw(propSeed() + 1)).not.toEqual(first);
});
