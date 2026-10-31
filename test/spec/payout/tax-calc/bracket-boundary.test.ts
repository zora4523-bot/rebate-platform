// B2-08c (规划/08 BR-WDR-20 应扣按配置的累进税率表; task §9.2 1「取 X 落入的档」, §9.5 ③): the bracket X
// falls in is the last one whose from_fen ≤ X — a bracket starts exactly at its from_fen. kit.ts
// TABLE is continuous at every boundary (both neighbours give the same due there), so these tables
// jump: choosing by from_fen < X, by the first bracket instead of the last, or by the next bracket's
// start gives a different due exactly at, one fen below or one fen above a from_fen.
// The tables are synthetic (the real rates wait for the tax adviser, 06 Q-F6).
// Top-level it() only (规划/11 §4.3); the property's runs and seed come from PROP_RUNS / PROP_SEED
// (@couli/testing), its body returns a boolean and the one assertion is outside fc.check; it first
// calls the function under test on a fixed example.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  cumulativeTaxFen,
  dueTaxFen,
  type TaxBracket,
} from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import { roundHalfUp, toBracket } from './kit.ts';

/** The timeout grows with the runs (as math.test.ts). */
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

/** 0 % below 100 000, 10 % from 100 000 on: due jumps from 0 to 10 000 at 100 000. */
const STEP: readonly TaxBracket[] = [
  { from_fen: 0, rate_bp: 0, quick_deduction_fen: 0 },
  { from_fen: 100_000, rate_bp: 1000, quick_deduction_fen: 0 },
].map(toBracket);

/** 10 % below 100 000, 30 % − 5 000 from 100 000 on: due jumps from 10 000 to 25 000. */
const STEP_WITH_DEDUCTION: readonly TaxBracket[] = [
  { from_fen: 0, rate_bp: 1000, quick_deduction_fen: 0 },
  { from_fen: 100_000, rate_bp: 3000, quick_deduction_fen: 5_000 },
].map(toBracket);

/** 0 % / 10 % from 100 000 / 20 % from 200 000: X past several from_fen takes the last of them. */
const STAIRS: readonly TaxBracket[] = [
  { from_fen: 0, rate_bp: 0, quick_deduction_fen: 0 },
  { from_fen: 100_000, rate_bp: 1000, quick_deduction_fen: 0 },
  { from_fen: 200_000, rate_bp: 2000, quick_deduction_fen: 0 },
].map(toBracket);

/** due(X) of STAIRS written out by hand. */
function stairsDue(x: bigint): bigint {
  if (x >= 200_000n) return roundHalfUp(x, 2000n, 10_000n);
  if (x >= 100_000n) return roundHalfUp(x, 1000n, 10_000n);
  return 0n;
}

/** The first counterexample of `holds` (null when every run holds). */
function firstViolation<T>(arb: fc.Arbitrary<T>, holds: (value: T) => boolean): unknown {
  const details = fc.check(
    fc.property(arb, (value) => holds(value)),
    propParams(),
  );
  if (!details.failed) return null;
  const example = details.counterexample;
  if (example === null) return { error: String(details.errorInstance) };
  return JSON.stringify(example, (_key: string, value: unknown) =>
    typeof value === 'bigint' ? `${value}n` : value,
  );
}

it('[AC-B2-08c#due] 不连续档位 [{0,0,0},{100000,1000bp,0}]：低 1 分 → 0；恰好 100000 → 10000（起点属于本档）；高 1 分 → 10000', () => {
  expect(dueTaxFen(99_999n, STEP)).toBe(0n);
  expect(dueTaxFen(100_000n, STEP)).toBe(10_000n);
  expect(dueTaxFen(100_001n, STEP)).toBe(10_000n); // 10 000.1
  expect(dueTaxFen(0n, STEP)).toBe(0n);
  expect(dueTaxFen(100_005n, STEP)).toBe(10_001n); // 10 000.5
});

it('[AC-B2-08c#due] 不连续档位带速算扣除 [{0,1000bp,0},{100000,3000bp,5000}]：低 1 分 → 10000；恰好 → 25000；高 1 分 → 25000', () => {
  expect(dueTaxFen(99_999n, STEP_WITH_DEDUCTION)).toBe(10_000n); // 9 999.9
  expect(dueTaxFen(100_000n, STEP_WITH_DEDUCTION)).toBe(25_000n); // 30 000 − 5 000
  expect(dueTaxFen(100_001n, STEP_WITH_DEDUCTION)).toBe(25_000n); // 30 000.3 − 5 000
  expect(dueTaxFen(99_995n, STEP_WITH_DEDUCTION)).toBe(10_000n); // 9 999.5
  expect(dueTaxFen(99_994n, STEP_WITH_DEDUCTION)).toBe(9_999n); // 9 999.4
});

it('[AC-B2-08c#due] 三档不连续 [{0,0},{100000,10%},{200000,20%}]：每个起点的低 1 分 / 恰好 / 高 1 分；越过多个起点取最后一个', () => {
  expect(dueTaxFen(99_999n, STAIRS)).toBe(0n);
  expect(dueTaxFen(100_000n, STAIRS)).toBe(10_000n);
  expect(dueTaxFen(100_001n, STAIRS)).toBe(10_000n);
  expect(dueTaxFen(199_999n, STAIRS)).toBe(20_000n); // 19 999.9
  expect(dueTaxFen(200_000n, STAIRS)).toBe(40_000n);
  expect(dueTaxFen(200_001n, STAIRS)).toBe(40_000n); // 40 000.2
  expect(dueTaxFen(10n ** 12n, STAIRS)).toBe(2n * 10n ** 11n);
});

it(
  '[AC-B2-08c#due] 任意 X（0..10^9，含每个起点 ±1 分）：三档不连续表的应扣与手写的分段公式一致',
  () => {
    expect(dueTaxFen(200_000n, STAIRS)).toBe(40_000n);
    const near = fc
      .tuple(fc.constantFrom(100_000n, 200_000n), fc.bigInt({ min: -2n, max: 2n }))
      .map(([start, offset]) => start + offset);
    const arb = fc.oneof(near, fc.bigInt({ min: 0n, max: 10n ** 9n }));
    expect(firstViolation(arb, (x) => dueTaxFen(x, STAIRS) === stairsDue(x))).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it('[AC-B2-08c#cumulative] 累计恰好落在不连续档的起点：本年 60000 + 在途 30000 + 本次 10000 = 100000 → 应扣 10000 − 已扣 0 − 在途税 0', () => {
  const base = {
    ytdIncomeFen: 60_000n,
    ytdWithheldFen: 0n,
    inFlightAmountFen: 30_000n,
    inFlightTaxFen: 0n,
    table: STEP,
  };
  expect(cumulativeTaxFen({ ...base, amountFen: 10_000n })).toBe(10_000n);
  // One fen short of the start: still the 0 % bracket.
  expect(cumulativeTaxFen({ ...base, amountFen: 9_999n })).toBe(0n);
});
