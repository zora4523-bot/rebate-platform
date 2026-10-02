// Rule tests for splitByBp (规划/08 BR-CALC-04 例 1–4, BR-CALC-08, BR-CALC-21 算例, BR-CALC-02
// 预留 + 分账). Ratios are listed in 08 order 本人 / 直推 / 间推; remainder = 平台留存
// (platform_retain_fen, BR-CALC-02). Top-level it() only (规划/11 §4.3).
import { applyReserve, InvalidAmount, InvalidRatio, splitByBp } from '@couli/money';
import { expect, it } from 'vitest';

it('[BR-CALC-04] 例 1：B=1234，self 5000/1000/0 → 本人 617、直推 123、间推 0、平台 494', () => {
  expect(splitByBp(1234n, [5000n, 1000n, 0n])).toEqual({
    shares: [617n, 123n, 0n],
    remainder: 494n,
  });
});

it('[BR-CALC-04] 例 2：B=1234，无上级（直推比例按 0）→ 本人 617、直推 0、平台 617', () => {
  expect(splitByBp(1234n, [5000n, 0n])).toEqual({ shares: [617n, 0n], remainder: 617n });
});

it('[BR-CALC-04] 例 3：B=1，self 5000/1000/0 → 0、0、0，平台 1', () => {
  expect(splitByBp(1n, [5000n, 1000n, 0n])).toEqual({ shares: [0n, 0n, 0n], remainder: 1n });
});

it('[BR-CALC-04] 例 4：N_base=1000、reserve 1500 → B=850，份额 425/85/0，平台 340 + 预留 150 = 490', () => {
  const reserve = applyReserve(1000n, 1500n);
  const split = splitByBp(reserve.after_reserve_fen, [5000n, 1000n, 0n]);
  expect({
    reserve,
    split,
    platform_total: reserve.reserve_fen + split.remainder,
  }).toEqual({
    reserve: { after_reserve_fen: 850n, reserve_fen: 150n },
    split: { shares: [425n, 85n, 0n], remainder: 340n },
    platform_total: 490n,
  });
});

it('[BR-CALC-04] 例 4 变体：本人 L3 r_own=6500 → 本人 552、直推 85、平台 213 + 150 = 363', () => {
  const split = splitByBp(850n, [6500n, 1000n]);
  expect({ split, platform_total: 150n + split.remainder }).toEqual({
    split: { shares: [552n, 85n], remainder: 213n },
    platform_total: 363n,
  });
});

it('[BR-CALC-04] 例 4 开启间推 r_indirect=500 → 间推 floor(42.5)=42，平台 298 + 150 = 448', () => {
  const split = splitByBp(850n, [5000n, 1000n, 500n]);
  expect({ split, platform_total: 150n + split.remainder }).toEqual({
    split: { shares: [425n, 85n, 42n], remainder: 298n },
    platform_total: 448n,
  });
});

it('[BR-CALC-08] 例：B=1235、5000/1000 → 617、123，平台 495（尾差全归平台）', () => {
  expect(splitByBp(1235n, [5000n, 1000n])).toEqual({ shares: [617n, 123n], remainder: 495n });
});

it('[BR-CALC-08] 例：B=9、5000/1000 → 4、0，平台 5', () => {
  expect(splitByBp(9n, [5000n, 1000n])).toEqual({ shares: [4n, 0n], remainder: 5n });
});

it('[BR-CALC-21] 算例：B=2000 分享 → 1000/200/800', () => {
  expect(splitByBp(2000n, [5000n, 1000n])).toEqual({ shares: [1000n, 200n], remainder: 800n });
});

it('[BR-CALC-21] 算例：B=0 → 各份额 0，平台 0', () => {
  expect(splitByBp(0n, [5000n, 1000n, 500n])).toEqual({ shares: [0n, 0n, 0n], remainder: 0n });
});

it('[BR-CALC-04] 没有受益人比例时整个 B 归平台', () => {
  expect(splitByBp(1234n, [])).toEqual({ shares: [], remainder: 1234n });
});

it('[BR-CALC-08] 每份单独 floor，不是先算平台再倒推：B=3、3333/3333/3333 → 0/0/0，平台 3', () => {
  // A split that computed the platform share first (floor(3 × 1 / 10000) = 0) and then handed
  // B − platform to the users would pay out 3 fen; 08 requires each user share floored alone.
  expect(splitByBp(3n, [3333n, 3333n, 3333n])).toEqual({
    shares: [0n, 0n, 0n],
    remainder: 3n,
  });
});

it('[BR-CALC-08] 每份单独 floor：B=7、5000/5000 → 3/3，平台 1（Σ份额 ≤ B）', () => {
  expect(splitByBp(7n, [5000n, 5000n])).toEqual({ shares: [3n, 3n], remainder: 1n });
});

it('[BR-CALC-01] 负基数抛 InvalidAmount（负 N 由调用方先按 BR-CALC-02 置 0）', () => {
  expect(() => splitByBp(-1n, [5000n])).toThrow(InvalidAmount);
});

it('[BR-CALC-01] 基数不是 bigint（number 1234）抛 InvalidAmount', () => {
  expect(() => splitByBp(1234 as unknown as bigint, [5000n])).toThrow(InvalidAmount);
});

it('[BR-CALC-01] 任一比例超界（10001、-1）或不是 bigint（5000 的 number）抛 InvalidRatio', () => {
  expect(() => splitByBp(1234n, [5000n, 10001n])).toThrow(InvalidRatio);
  expect(() => splitByBp(1234n, [-1n])).toThrow(InvalidRatio);
  expect(() => splitByBp(1234n, [5000 as unknown as bigint])).toThrow(InvalidRatio);
});

it('[BR-CALC-08] 比例合计超过 10000（会使 Σ用户份额 > B、平台留存 < 0）抛 InvalidRatio', () => {
  expect(() => splitByBp(1234n, [6000n, 5000n])).toThrow(InvalidRatio);
});

it('[BR-CALC-08] 比例合计恰为 10000 时允许：B=1235、5000/5000 → 617/617，平台 1', () => {
  expect(splitByBp(1235n, [5000n, 5000n])).toEqual({ shares: [617n, 617n], remainder: 1n });
});

it('[BR-CALC-21] 相同输入输出相同，且不修改传入的比例数组', () => {
  const ratios: readonly bigint[] = Object.freeze([5000n, 1000n, 0n]);
  const first = splitByBp(1234n, ratios);
  const second = splitByBp(1234n, ratios);
  expect({ first, second, ratios: [...ratios] }).toEqual({
    first: { shares: [617n, 123n, 0n], remainder: 494n },
    second: { shares: [617n, 123n, 0n], remainder: 494n },
    ratios: [5000n, 1000n, 0n],
  });
});
