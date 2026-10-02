// Property tests for applyReserve (规划/08 BR-CALC-02 分佣基数与平台预留, BR-CALC-21 平台预留
// 另加的属性; 规划/11 §4.2–§4.3). tlj_deduct_fen is 0 here (first version, BR-CALC-02 细则).
import { applyReserve, InvalidRatio, splitByBp } from '@couli/money';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  badRatioBp,
  BP,
  bucketOf,
  coverage,
  FULL_COVERAGE,
  ratioBp,
  sharesBp,
  signedFen,
  sum,
  throwsInstanceOf,
} from './arb.ts';

const pos = (n: bigint): bigint => (n > 0n ? n : 0n);

it('[BR-CALC-21] reserve_fen ≥ 0，after_rsv ≥ 0，after_rsv + reserve_fen == max(0, N_base)', () => {
  const stats = createPropStats('money:applyReserve:conservation');
  fc.assert(
    fc.property(signedFen, ratioBp, (n, r) => {
      stats.hit(bucketOf(n));
      const { after_reserve_fen: after, reserve_fen: reserve } = applyReserve(n, r);
      return (
        typeof after === 'bigint' &&
        typeof reserve === 'bigint' &&
        after >= 0n &&
        reserve >= 0n &&
        after + reserve === pos(n)
      );
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-02] after_rsv = floor(N_pos × (10000 − reserve_bp) / 10000)，取整尾差归平台预留', () => {
  const stats = createPropStats('money:applyReserve:floor');
  fc.assert(
    fc.property(signedFen, ratioBp, (n, r) => {
      stats.hit(bucketOf(n));
      const { after_reserve_fen: after } = applyReserve(n, r);
      const scaled = pos(n) * (BP - r);
      return after * BP <= scaled && scaled < (after + 1n) * BP;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-21] reserve_bp=0 时 B 与不扣预留的结果相同', () => {
  const stats = createPropStats('money:applyReserve:zero-reserve');
  fc.assert(
    fc.property(signedFen, (n) => {
      stats.hit(bucketOf(n));
      const { after_reserve_fen: after, reserve_fen: reserve } = applyReserve(n, 0n);
      return after === pos(n) && reserve === 0n;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-02] 对 reserve_bp 单调：预留比例调高，after_rsv 不增、reserve_fen 不减', () => {
  const stats = createPropStats('money:applyReserve:monotonic');
  fc.assert(
    fc.property(signedFen, ratioBp, ratioBp, (n, x, y) => {
      stats.hit(bucketOf(n));
      const [lo, hi] = x <= y ? [x, y] : [y, x];
      const a = applyReserve(n, lo);
      const b = applyReserve(n, hi);
      return b.after_reserve_fen <= a.after_reserve_fen && b.reserve_fen >= a.reserve_fen;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-21] 先扣预留再分账：Σ用户份额 + platform_retain_fen + reserve_fen == max(0, N_base)，Σ用户份额 ≤ B', () => {
  const stats = createPropStats('money:applyReserve:with-split');
  fc.assert(
    fc.property(signedFen, ratioBp, sharesBp(8000n), (n, r, bps) => {
      stats.hit(bucketOf(n));
      const { after_reserve_fen: base, reserve_fen: reserve } = applyReserve(n, r);
      const { shares, remainder } = splitByBp(base, bps);
      return sum(shares) + remainder + reserve === pos(n) && sum(shares) <= base;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-02] reserve_bp 超出 0–10000 一律抛 InvalidRatio', () => {
  const stats = createPropStats('money:applyReserve:bad-ratio');
  fc.assert(
    fc.property(signedFen, badRatioBp, (n, r) => {
      stats.hit(bucketOf(n));
      return throwsInstanceOf(() => applyReserve(n, r), InvalidRatio);
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});
