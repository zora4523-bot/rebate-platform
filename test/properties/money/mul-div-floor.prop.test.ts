// Property tests for mulDivFloor (规划/08 BR-CALC-01, BR-CALC-08; 规划/11 §4.2–§4.3).
// One property per top-level it(); the property body returns a boolean; one summary assertion
// after fc.assert; run count and seed only from @couli/testing.
import { InvalidAmount, InvalidRatio, mulDivFloor } from '@couli/money';
import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  amountFen,
  badRatioBp,
  BP,
  bucketOf,
  coverage,
  FULL_COVERAGE,
  negativeFen,
  ratioBp,
  throwsInstanceOf,
} from './arb.ts';

it('[BR-CALC-08] mulDivFloor 是精确的向下取整：r×10000 ≤ a×bp < (r+1)×10000', () => {
  const stats = createPropStats('money:mulDivFloor:exact-floor');
  fc.assert(
    fc.property(amountFen, ratioBp, (a, bp) => {
      stats.hit(bucketOf(a));
      const r = mulDivFloor(a, bp, BP);
      return typeof r === 'bigint' && r * BP <= a * bp && a * bp < (r + 1n) * BP;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-08] mulDivFloor 对比例单调不减：bp1 ≤ bp2 ⇒ f(a, bp1) ≤ f(a, bp2)', () => {
  const stats = createPropStats('money:mulDivFloor:monotonic-bp');
  fc.assert(
    fc.property(amountFen, ratioBp, ratioBp, (a, x, y) => {
      stats.hit(bucketOf(a));
      const [lo, hi] = x <= y ? [x, y] : [y, x];
      return mulDivFloor(a, lo, BP) <= mulDivFloor(a, hi, BP);
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-08] mulDivFloor 对金额单调不减：a1 ≤ a2 ⇒ f(a1, bp) ≤ f(a2, bp)', () => {
  const stats = createPropStats('money:mulDivFloor:monotonic-amount');
  fc.assert(
    fc.property(amountFen, amountFen, ratioBp, (x, y, bp) => {
      stats.hit(bucketOf(x));
      const [lo, hi] = x <= y ? [x, y] : [y, x];
      return mulDivFloor(lo, bp, BP) <= mulDivFloor(hi, bp, BP);
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-01] mulDivFloor 只接受 amount_fen ≥ 0：任何负数都抛 InvalidAmount', () => {
  const stats = createPropStats('money:mulDivFloor:negative-amount');
  fc.assert(
    fc.property(negativeFen, ratioBp, (a, bp) => {
      stats.hit(bucketOf(a));
      return throwsInstanceOf(() => mulDivFloor(a, bp, BP), InvalidAmount);
    }),
    propParams(),
  );
  expect(stats.flush().hits).toEqual({ negative: propRuns() });
});

it('[BR-CALC-01] mulDivFloor 的 _bp 超出 0–10000 一律抛 InvalidRatio，不静默截断', () => {
  const stats = createPropStats('money:mulDivFloor:bad-ratio');
  fc.assert(
    fc.property(amountFen, badRatioBp, (a, bp) => {
      stats.hit(bucketOf(a));
      return throwsInstanceOf(() => mulDivFloor(a, bp, BP), InvalidRatio);
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-01] 不用浮点：金额以任何 JS number（整数、小数、NaN、Infinity）传入都抛 InvalidAmount', () => {
  const stats = createPropStats('money:mulDivFloor:number-amount');
  const anyNumber = fc.oneof(fc.maxSafeInteger(), fc.double());
  fc.assert(
    fc.property(anyNumber, ratioBp, (n, bp) => {
      stats.hit(Number.isInteger(n) ? 'integer' : Number.isFinite(n) ? 'fraction' : 'non_finite');
      return throwsInstanceOf(() => mulDivFloor(n as unknown as bigint, bp, BP), InvalidAmount);
    }),
    propParams(),
  );
  const hits = stats.flush().hits;
  expect({
    integer: propRuns() < 1000 || (hits['integer'] ?? 0) > 0,
    fraction: propRuns() < 1000 || (hits['fraction'] ?? 0) > 0,
  }).toEqual({ integer: true, fraction: true });
});
