// Property tests for splitByBp (规划/08 BR-CALC-21 分账不变量, BR-CALC-08 舍入与尾差,
// BR-CALC-07 比例合计上限; 规划/11 §4.2–§4.3). Shares are computed only through
// @couli/money; the reference value for each share is its defining inequality, not a copy of
// the implementation.
import { InvalidAmount, InvalidRatio, mulDivFloor, splitByBp } from '@couli/money';
import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  amountFen,
  BP,
  bucketOf,
  coverage,
  FULL_COVERAGE,
  negativeFen,
  overfullSharesBp,
  sharesBp,
  sum,
  throwsInstanceOf,
} from './arb.ts';

it('[BR-CALC-21] Σ份额 + 平台留存 == B，份额个数与比例个数相同', () => {
  const stats = createPropStats('money:splitByBp:sum');
  fc.assert(
    fc.property(amountFen, sharesBp(), (base, bps) => {
      stats.hit(bucketOf(base));
      const { shares, remainder } = splitByBp(base, bps);
      return shares.length === bps.length && sum(shares) + remainder === base;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-21] 每份 ≥ 0，Σ用户份额 ≤ B，平台留存 ≥ 0', () => {
  const stats = createPropStats('money:splitByBp:non-negative');
  fc.assert(
    fc.property(amountFen, sharesBp(), (base, bps) => {
      stats.hit(bucketOf(base));
      const { shares, remainder } = splitByBp(base, bps);
      return shares.every((s) => s >= 0n) && sum(shares) <= base && remainder >= 0n;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-08] 每份单独 floor：s×10000 ≤ B×bp < (s+1)×10000，且等于 mulDivFloor(B, bp, 10000)', () => {
  const stats = createPropStats('money:splitByBp:each-floor');
  fc.assert(
    fc.property(amountFen, sharesBp(), (base, bps) => {
      stats.hit(bucketOf(base));
      const { shares } = splitByBp(base, bps);
      return bps.every((bp, i) => {
        const s = shares[i];
        return (
          typeof s === 'bigint' &&
          s * BP <= base * bp &&
          base * bp < (s + 1n) * BP &&
          s === mulDivFloor(base, bp, BP)
        );
      });
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-08] 对比例单调：调高某一份的 bp，该份额不减、平台留存不增', () => {
  const stats = createPropStats('money:splitByBp:monotonic');
  const input = fc
    .tuple(amountFen, sharesBp())
    .map(([base, bps]) => [base, bps.length === 0 ? [0n] : bps] as const)
    .chain(([base, bps]) =>
      fc.tuple(
        fc.constant(base),
        fc.constant(bps),
        fc.nat({ max: bps.length - 1 }),
        fc.bigInt({ min: 0n, max: BP - sum(bps) }),
      ),
    );
  fc.assert(
    fc.property(input, ([base, bps, j, delta]) => {
      stats.hit(bucketOf(base));
      const raised = bps.map((bp, i) => (i === j ? bp + delta : bp));
      const before = splitByBp(base, bps);
      const after = splitByBp(base, raised);
      const sBefore = before.shares[j];
      const sAfter = after.shares[j];
      return (
        sBefore !== undefined &&
        sAfter !== undefined &&
        sAfter >= sBefore &&
        after.remainder <= before.remainder
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-07] 比例合计 ≤ 8000 时平台留存 ≥ B × 20%（尾差另计归平台）', () => {
  const stats = createPropStats('money:splitByBp:cap-8000');
  fc.assert(
    fc.property(amountFen, sharesBp(8000n), (base, bps) => {
      stats.hit(bucketOf(base));
      const { remainder } = splitByBp(base, bps);
      return remainder * BP >= base * 2000n;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-08] 比例合计 > 10000（Σ用户份额可能超过 B）一律抛 InvalidRatio', () => {
  const stats = createPropStats('money:splitByBp:overfull');
  fc.assert(
    fc.property(amountFen, overfullSharesBp, (base, bps) => {
      stats.hit(bucketOf(base));
      return throwsInstanceOf(() => splitByBp(base, bps), InvalidRatio);
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-01] 负基数一律抛 InvalidAmount', () => {
  const stats = createPropStats('money:splitByBp:negative-base');
  fc.assert(
    fc.property(negativeFen, sharesBp(), (base, bps) => {
      stats.hit(bucketOf(base));
      return throwsInstanceOf(() => splitByBp(base, bps), InvalidAmount);
    }),
    propParams(),
  );
  expect(stats.flush().hits).toEqual({ negative: propRuns() });
});

it('[BR-CALC-21] 相同输入输出相同，且不修改传入的比例数组', () => {
  const stats = createPropStats('money:splitByBp:deterministic');
  fc.assert(
    fc.property(amountFen, sharesBp(), (base, bps) => {
      stats.hit(bucketOf(base));
      const pristine = [...bps];
      const first = splitByBp(base, bps);
      const second = splitByBp(base, [...pristine]);
      return (
        first.remainder === second.remainder &&
        first.shares.length === second.shares.length &&
        first.shares.every((s, i) => s === second.shares[i]) &&
        bps.length === pristine.length &&
        bps.every((bp, i) => bp === pristine[i])
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});
