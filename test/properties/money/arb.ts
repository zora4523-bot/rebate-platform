// Shared generators and coverage check for the money property tests (规划/11 §4.2).
// Amount bases cover 0, 1, odd values and values above 2^31; each bucket must get >= 1% of the
// runs. Ratios are bigint basis points; no generator here ever produces a JS number amount.
import { propRuns } from '@couli/testing';
import type { PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';

export const BP = 10000n;
export const TWO_POW_31 = 2n ** 31n;
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;
export const MAX_SAFE = 2n ** 53n - 1n;

/** Non-negative amount in fen, up to the PG bigint maximum. */
export const amountFen = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.constant(1n), weight: 1 },
  { arbitrary: fc.bigInt({ min: 2n, max: TWO_POW_31 }), weight: 4 },
  { arbitrary: fc.bigInt({ min: TWO_POW_31 + 1n, max: INT64_MAX }), weight: 4 },
);

/**
 * Largest whole-yuan value whose fen amount stays within PG bigint for every two-decimal tail:
 * MAX_YUAN * 100 + 99 <= INT64_MAX (BR-CALC-01). Yuan strings above it are out of range and must
 * be rejected (test/spec/money/review-additions.test.ts), so the parse properties stop here.
 */
export const MAX_YUAN = (INT64_MAX - 99n) / 100n;

/** Non-negative whole yuan whose fen value fits PG bigint; same buckets as amountFen. */
export const amountYuan = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.constant(1n), weight: 1 },
  { arbitrary: fc.bigInt({ min: 2n, max: TWO_POW_31 }), weight: 4 },
  { arbitrary: fc.bigInt({ min: TWO_POW_31 + 1n, max: MAX_YUAN }), weight: 4 },
);

/** Any amount, negative included (raw N may be negative, BR-CALC-02). */
export const signedFen = fc.oneof(
  { arbitrary: amountFen, weight: 3 },
  { arbitrary: fc.bigInt({ min: INT64_MIN, max: -1n }), weight: 1 },
);

/** Strictly negative amount. */
export const negativeFen = fc.bigInt({ min: INT64_MIN, max: -1n });

/** A valid ratio in basis points, boundaries weighted in. */
export const ratioBp = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.constant(BP), weight: 1 },
  { arbitrary: fc.bigInt({ min: 1n, max: BP - 1n }), weight: 8 },
);

/** An out-of-range ratio: below 0 or above 10000. */
export const badRatioBp = fc.oneof(
  fc.bigInt({ min: INT64_MIN, max: -1n }),
  fc.bigInt({ min: BP + 1n, max: INT64_MAX }),
);

/**
 * 0..4 ratios whose sum is at most `total` (built from sorted cut points, no filtering, so no
 * discards). The sum reaches `total` exactly in a fair share of cases.
 */
export function sharesBp(total: bigint = BP): fc.Arbitrary<bigint[]> {
  return fc
    .array(fc.oneof(fc.bigInt({ min: 0n, max: total }), fc.constant(total)), { maxLength: 4 })
    .map((cuts) => {
      const sorted = [...cuts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts: bigint[] = [];
      let previous = 0n;
      for (const cut of sorted) {
        parts.push(cut - previous);
        previous = cut;
      }
      return parts;
    });
}

/** 2..4 valid ratios whose sum is above 10000 (each one alone is valid). */
export const overfullSharesBp: fc.Arbitrary<bigint[]> = fc
  .tuple(
    fc.bigInt({ min: 1n, max: BP }),
    fc.array(fc.bigInt({ min: 0n, max: BP }), { maxLength: 2 }),
  )
  .chain(([first, rest]) =>
    fc.bigInt({ min: BP + 1n - first, max: BP }).map((second) => [first, second, ...rest]),
  );

export function sum(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function bucketOf(value: bigint): string {
  if (value < 0n) return 'negative';
  if (value === 0n) return 'zero';
  if (value === 1n) return 'one';
  if (value > TWO_POW_31) return 'gt_2_31';
  return value % 2n === 1n ? 'odd' : 'even';
}

/**
 * The four required amount buckets each got >= 1% of the runs, with no discards. Below 1000 runs
 * the 1% floor is not meaningful and only the discard count is checked.
 */
export function coverage(record: PropStatsRecord): Record<string, boolean> {
  const runs = propRuns();
  const floor = runs / 100;
  const enough = (bucket: string): boolean => runs < 1000 || (record.hits[bucket] ?? 0) >= floor;
  return {
    zero: enough('zero'),
    one: enough('one'),
    odd: enough('odd'),
    gt_2_31: enough('gt_2_31'),
    no_discards: record.discards === 0,
  };
}

export const FULL_COVERAGE: Record<string, boolean> = {
  zero: true,
  one: true,
  odd: true,
  gt_2_31: true,
  no_discards: true,
};

/** Runs `fn` and reports whether it threw an instance of `cls` (any other outcome is false). */
export function throwsInstanceOf(
  fn: () => unknown,
  cls: abstract new (...args: never[]) => Error,
): boolean {
  try {
    fn();
  } catch (error) {
    return error instanceof cls;
  }
  return false;
}
