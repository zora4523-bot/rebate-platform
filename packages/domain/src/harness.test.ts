// Harness check only: proves vitest + fast-check + @couli/testing work in this package.
// It contains no domain rule.
// Rule tests live in test/spec and test/properties (规划/11 §4.4).
import { propParams, propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

const fen = fc.bigInt({ min: 0n, max: 2n ** 63n - 1n });

it('executes a bigint property exactly propRuns() times', () => {
  let executed = 0;
  fc.assert(
    fc.property(fen, fen, (a, b) => {
      executed += 1;
      return a + b >= a && a + b >= b;
    }),
    propParams(),
  );
  expect(executed).toBe(propRuns());
});

it('generates the same bigint sequence for the same seed', () => {
  const draw = (): bigint[] => fc.sample(fen, { numRuns: 64, seed: propSeed() });
  const first = draw();
  expect(first).toHaveLength(64);
  expect(draw()).toEqual(first);
});
