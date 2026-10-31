// B2-08c (规划/08 BR-WDR-20; task §9.2 1, §9.3 纯函数): the pure arithmetic of the tax calculator.
//   mulDivRoundHalfUp  round_half_up(a × r / d) in bigint (0.5 fen goes up; no floating point);
//   flatRateTaxFen     flat_rate: round_half_up(amount × rate_bp / 10000) (08 例: 2000bp, ¥100 → 2000);
//   dueTaxFen          应扣(X) over the progressive table: the bracket X falls in (last from_fen ≤ X,
//                      beyond the last bracket the last one), round_half_up(X × rate_bp / 10000) −
//                      quick_deduction_fen; an empty table → 0;
//   cumulativeTaxFen   max(0, 应扣(ytd income + in-flight amounts + amount) − ytd withheld −
//                      in-flight tax) (08 累计方法; a failed in-flight withdrawal is taken back on the
//                      next one, whose tax may be 0);
//   taxRuleVersion     stable for the same configuration, different when method / rate / any bracket
//                      changes, independent of the key order of a bracket.
// The table is synthetic (kit.ts TABLE): the real rates wait for the tax adviser.
// Top-level it() only (规划/11 §4.3); the properties' runs and seed come from PROP_RUNS / PROP_SEED
// (@couli/testing), each body returns a boolean and the one assertion is outside fc.check; each
// test first calls the function under test on a fixed example.
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  cumulativeTaxFen,
  dueTaxFen,
  flatRateTaxFen,
  mulDivRoundHalfUp,
  taxRuleVersion,
  type TaxBracket,
  type TaxConfig,
} from '../../../../apps/api/src/modules/payout/application/fee-tax-calculator.ts';
import { TABLE, roundHalfUp, tableDue } from './kit.ts';

/** The timeout grows with the runs (as test/spec/payout/tax-ytd/year.test.ts). */
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));
/** 2^53 + 1: not representable as a JS number. */
const BEYOND_SAFE = 9_007_199_254_740_993n;

/** The first counterexample of `property` (null when every run holds). */
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

it('[AC-B2-08c#round] round_half_up 边界：0.5 分进位、0.45 / 0.4999 舍去、3.5 → 4；超出 2^53 的金额精确（bigint，不走浮点）', () => {
  expect(mulDivRoundHalfUp(1n, 5000n, 10000n)).toBe(1n); // 0.5
  expect(mulDivRoundHalfUp(2n, 2500n, 10000n)).toBe(1n); // 0.5
  expect(mulDivRoundHalfUp(5000n, 1n, 10000n)).toBe(1n); // 0.5
  expect(mulDivRoundHalfUp(4999n, 1n, 10000n)).toBe(0n); // 0.4999
  expect(mulDivRoundHalfUp(3n, 1500n, 10000n)).toBe(0n); // 0.45
  expect(mulDivRoundHalfUp(5n, 1500n, 10000n)).toBe(1n); // 0.75
  expect(mulDivRoundHalfUp(10n, 1500n, 10000n)).toBe(2n); // 1.5
  expect(mulDivRoundHalfUp(7n, 5000n, 10000n)).toBe(4n); // 3.5
  expect(mulDivRoundHalfUp(0n, 10000n, 10000n)).toBe(0n);
  expect(mulDivRoundHalfUp(12345n, 10000n, 10000n)).toBe(12345n);
  expect(mulDivRoundHalfUp(12345n, 0n, 10000n)).toBe(0n);
  expect(mulDivRoundHalfUp(BEYOND_SAFE, 5000n, 10000n)).toBe(4_503_599_627_370_497n);
  expect(mulDivRoundHalfUp(BEYOND_SAFE, 1n, 10000n)).toBe(900_719_925_474n);
});

it(
  '[AC-B2-08c#round] 任意金额（0..2^62）与比例（0..10000bp）：结果 = floor((2·a·r + d) / 2d)，即四舍五入到分',
  () => {
    expect(mulDivRoundHalfUp(1n, 5000n, 10000n)).toBe(1n);
    const arb = fc.tuple(
      fc.bigInt({ min: 0n, max: 2n ** 62n }),
      fc.bigInt({ min: 0n, max: 10000n }),
    );
    const holds = ([a, r]: [bigint, bigint]) =>
      mulDivRoundHalfUp(a, r, 10000n) === roundHalfUp(a, r, 10000n);
    expect(firstViolation(arb, holds)).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it('[AC-B2-08c#flat] flat_rate：08 例 2000bp、¥100 → 税 2000 分；0.5 分进位；税率 0 → 0；10000bp → 全额', () => {
  expect(flatRateTaxFen(10000n, 2000n)).toBe(2000n);
  expect(10000n - flatRateTaxFen(10000n, 2000n)).toBe(8000n);
  expect(flatRateTaxFen(25n, 2000n)).toBe(5n);
  expect(flatRateTaxFen(1n, 5000n)).toBe(1n);
  expect(flatRateTaxFen(3n, 1500n)).toBe(0n);
  expect(flatRateTaxFen(0n, 2000n)).toBe(0n);
  expect(flatRateTaxFen(123_456n, 0n)).toBe(0n);
  expect(flatRateTaxFen(123_456n, 10000n)).toBe(123_456n);
});

it(
  '[AC-B2-08c#flat] 任意金额与 0..10000bp：税 = round_half_up(amount × bp / 10000)，0 ≤ 税 ≤ 金额',
  () => {
    expect(flatRateTaxFen(10000n, 2000n)).toBe(2000n);
    const arb = fc.tuple(
      fc.bigInt({ min: 0n, max: 10n ** 15n }),
      fc.bigInt({ min: 0n, max: 10000n }),
    );
    expect(
      firstViolation(arb, ([amount, rate]) => {
        const tax = flatRateTaxFen(amount, rate);
        return tax === roundHalfUp(amount, rate, 10000n) && tax >= 0n && tax <= amount;
      }),
    ).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it('[AC-B2-08c#due] 应扣(X) 取 X 落入的档：首档、中档、末档、超出末档仍按末档；档内四舍五入后减速算扣除', () => {
  expect(dueTaxFen(0n, TABLE)).toBe(0n);
  expect(dueTaxFen(4n, TABLE)).toBe(0n); // 0.4
  expect(dueTaxFen(5n, TABLE)).toBe(1n); // 0.5
  expect(dueTaxFen(35_000n, TABLE)).toBe(3_500n);
  expect(dueTaxFen(99_999n, TABLE)).toBe(10_000n); // 9 999.9
  expect(dueTaxFen(100_000n, TABLE)).toBe(10_000n);
  expect(dueTaxFen(100_003n, TABLE)).toBe(10_001n); // 20 000.6 → 20 001 − 10 000
  expect(dueTaxFen(300_000n, TABLE)).toBe(50_000n);
  expect(dueTaxFen(500_000n, TABLE)).toBe(90_000n);
  expect(dueTaxFen(1_000_000n, TABLE)).toBe(240_000n);
  expect(dueTaxFen(10n ** 12n, TABLE)).toBe(3n * 10n ** 11n - 60_000n);
});

it('[AC-B2-08c#due] 空档位 → 应扣恒为 0；单档 [{0, 2000bp, 0}] → round_half_up(X × 20%)', () => {
  for (const x of [0n, 1n, 35_000n, 10n ** 9n, BEYOND_SAFE]) {
    expect(dueTaxFen(x, []), `${x}`).toBe(0n);
  }
  const single: TaxBracket[] = [{ from_fen: 0n, rate_bp: 2000n, quick_deduction_fen: 0n }];
  expect(dueTaxFen(35_000n, single)).toBe(7_000n);
  expect(dueTaxFen(3n, single)).toBe(1n); // 0.6
  expect(dueTaxFen(2n, single)).toBe(0n); // 0.4
});

it(
  '[AC-B2-08c#due] 任意 X（0..10^13）：应扣与手写的分段公式一致',
  () => {
    expect(dueTaxFen(300_000n, TABLE)).toBe(50_000n);
    const arb = fc.bigInt({ min: 0n, max: 10n ** 13n });
    expect(firstViolation(arb, (x) => dueTaxFen(x, TABLE) === tableDue(x))).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it('[AC-B2-08c#cumulative] 累计算例：本年已到账 10000 / 已扣 2000，在途一单 5000 / 税 1000，本次 20000 → 应扣(35000) − 2000 − 1000', () => {
  const base = {
    ytdIncomeFen: 10_000n,
    ytdWithheldFen: 2_000n,
    inFlightAmountFen: 5_000n,
    inFlightTaxFen: 1_000n,
    amountFen: 20_000n,
  };
  expect(cumulativeTaxFen({ ...base, table: TABLE })).toBe(500n); // 3 500 − 3 000
  const single: TaxBracket[] = [{ from_fen: 0n, rate_bp: 2000n, quick_deduction_fen: 0n }];
  expect(cumulativeTaxFen({ ...base, table: single })).toBe(4_000n); // 7 000 − 3 000
  expect(cumulativeTaxFen({ ...base, table: [] })).toBe(0n);
});

it('[AC-B2-08c#cumulative] 在途单把本次推进高档；该在途单失败后，下一次提现自动冲回（本次税为 0），再下一次按累计补扣', () => {
  // W1 400 000 in flight (its tax 70 000); W2 200 000 applies: due(600 000) − 70 000.
  expect(
    cumulativeTaxFen({
      ytdIncomeFen: 0n,
      ytdWithheldFen: 0n,
      inFlightAmountFen: 400_000n,
      inFlightTaxFen: 70_000n,
      amountFen: 200_000n,
      table: TABLE,
    }),
  ).toBe(50_000n);
  // W1 failed, W2 paid (200 000 / 50 000 in tax_ytd): W3 10 000 → due(210 000) = 32 000 < 50 000.
  expect(
    cumulativeTaxFen({
      ytdIncomeFen: 200_000n,
      ytdWithheldFen: 50_000n,
      inFlightAmountFen: 0n,
      inFlightTaxFen: 0n,
      amountFen: 10_000n,
      table: TABLE,
    }),
  ).toBe(0n);
  // W3 paid with tax 0: W4 100 000 → due(310 000) − 50 000 = 2 000.
  expect(
    cumulativeTaxFen({
      ytdIncomeFen: 210_000n,
      ytdWithheldFen: 50_000n,
      inFlightAmountFen: 0n,
      inFlightTaxFen: 0n,
      amountFen: 100_000n,
      table: TABLE,
    }),
  ).toBe(2_000n);
});

it(
  '[AC-B2-08c#cumulative] 任意累计 / 在途 / 本次：税 = max(0, 应扣(合计) − 已扣 − 在途税) ≥ 0',
  () => {
    expect(
      cumulativeTaxFen({
        ytdIncomeFen: 10_000n,
        ytdWithheldFen: 2_000n,
        inFlightAmountFen: 5_000n,
        inFlightTaxFen: 1_000n,
        amountFen: 20_000n,
        table: TABLE,
      }),
    ).toBe(500n);
    const fen = fc.bigInt({ min: 0n, max: 10n ** 10n });
    const arb = fc.record({
      ytdIncomeFen: fen,
      ytdWithheldFen: fen,
      inFlightAmountFen: fen,
      inFlightTaxFen: fen,
      amountFen: fc.bigInt({ min: 1n, max: 10n ** 10n }),
    });
    expect(
      firstViolation(arb, (input) => {
        const tax = cumulativeTaxFen({ ...input, table: TABLE });
        const due = tableDue(input.ytdIncomeFen + input.inFlightAmountFen + input.amountFen);
        const left = due - input.ytdWithheldFen - input.inFlightTaxFen;
        return tax === (left > 0n ? left : 0n) && tax >= 0n;
      }),
    ).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

it(
  '[AC-B2-08c#cumulative] 一年内逐笔申请（之前的单无论已到账还是在途）：各笔税额之和 = 应扣(全年合计)',
  () => {
    expect(dueTaxFen(300_000n, TABLE)).toBe(50_000n);
    const arb = fc.array(
      fc.record({ amount: fc.bigInt({ min: 100n, max: 1_000_000n }), paid: fc.boolean() }),
      { minLength: 1, maxLength: 12 },
    );
    expect(
      firstViolation(arb, (steps) => {
        let ytdIncome = 0n;
        let ytdWithheld = 0n;
        let inFlightAmount = 0n;
        let inFlightTax = 0n;
        let total = 0n;
        let taxes = 0n;
        for (const step of steps) {
          const tax = cumulativeTaxFen({
            ytdIncomeFen: ytdIncome,
            ytdWithheldFen: ytdWithheld,
            inFlightAmountFen: inFlightAmount,
            inFlightTaxFen: inFlightTax,
            amountFen: step.amount,
            table: TABLE,
          });
          total += step.amount;
          taxes += tax;
          if (step.paid) {
            ytdIncome += step.amount;
            ytdWithheld += tax;
          } else {
            inFlightAmount += step.amount;
            inFlightTax += tax;
          }
        }
        return taxes === tableDue(total);
      }),
    ).toBeNull();
  },
  PROPERTY_TIMEOUT_MS,
);

const CUMULATIVE: TaxConfig = { method: 'cumulative', rate_bp: 0n, rate_table: TABLE };

it('[AC-B2-08c#version] tax_rule_version：同一配置稳定（分别构造、档位键顺序不同也相同），非空字符串', () => {
  const version = taxRuleVersion(CUMULATIVE);
  expect(typeof version).toBe('string');
  expect(version.length).toBeGreaterThan(0);
  expect(taxRuleVersion(CUMULATIVE)).toBe(version);
  const rebuilt: TaxConfig = {
    method: 'cumulative',
    rate_bp: 0n,
    rate_table: [
      { quick_deduction_fen: 0n, rate_bp: 1000n, from_fen: 0n },
      { rate_bp: 2000n, from_fen: 100_000n, quick_deduction_fen: 10_000n },
      { from_fen: 500_000n, quick_deduction_fen: 60_000n, rate_bp: 3000n },
    ],
  };
  expect(taxRuleVersion(rebuilt)).toBe(version);
  expect(taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] })).toBe(
    taxRuleVersion({ method: 'none', rate_bp: 0n, rate_table: [] }),
  );
});

it('[AC-B2-08c#version] tax_rule_version 随配置变化：方法、税率、任一档的起点 / 税率 / 速算扣除、档数，各不相同', () => {
  const at = (i: number, change: Partial<TaxBracket>): TaxBracket[] =>
    TABLE.map((row, k) => (k === i ? { ...row, ...change } : row));
  const configs: TaxConfig[] = [
    { method: 'none', rate_bp: 0n, rate_table: [] },
    { method: 'flat_rate', rate_bp: 0n, rate_table: [] },
    { method: 'cumulative', rate_bp: 0n, rate_table: [] },
    { method: 'flat_rate', rate_bp: 2000n, rate_table: [] },
    { method: 'flat_rate', rate_bp: 2500n, rate_table: [] },
    CUMULATIVE,
    { ...CUMULATIVE, rate_table: at(1, { from_fen: 200_000n }) },
    { ...CUMULATIVE, rate_table: at(1, { rate_bp: 2500n }) },
    { ...CUMULATIVE, rate_table: at(2, { quick_deduction_fen: 70_000n }) },
    { ...CUMULATIVE, rate_table: TABLE.slice(0, 2) },
  ];
  const versions = configs.map((config) => taxRuleVersion(config));
  expect(new Set(versions).size).toBe(configs.length);
});
