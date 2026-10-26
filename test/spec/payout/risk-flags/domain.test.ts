// B2-11a: BR-WDR-29 ④⑤⑥ as pure functions with their thresholds as parameters (task 9.3 #3 / #7;
// BR-WDR-30 ⑧ reuses them). Boundaries: ④⑤⑥ compare with「>」exactly (numerator × 10000 >
// threshold × denominator), ⑤'s single rate and minimum count with「≥」; value = bp floored.
// Properties run with propParams() (PROP_RUNS / PROP_SEED) and return a boolean.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  commissionRateBp,
  highCommissionRatioFlag,
  invalidRatioFlag,
  withdrawVsReceivedFlag,
  type CommissionFact,
  type HighCommissionThresholds,
  type InvalidRatioThresholds,
  type WithdrawReceivedThresholds,
  type WithdrawRiskFlag,
} from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';
import { DEFAULTS, flag } from './oracle.ts';

/** `actual` is exactly `want`: both null, or the same three keys with identical values. */
function same(actual: WithdrawRiskFlag | null, want: WithdrawRiskFlag | null): boolean {
  if (want === null || actual === null) return actual === want;
  return (
    Object.keys(actual).length === 3 &&
    actual.code === want.code &&
    actual.value === want.value &&
    actual.threshold === want.threshold
  );
}

const IR: InvalidRatioThresholds = {
  invalid_ratio_bp: DEFAULTS.invalid_ratio_bp,
  invalid_min_count: DEFAULTS.invalid_min_count,
};
const HC: HighCommissionThresholds = {
  high_commission_rate_bp: DEFAULTS.high_commission_rate_bp,
  high_commission_ratio_bp: DEFAULTS.high_commission_ratio_bp,
  min_orders: DEFAULTS.min_orders,
};
const WR: WithdrawReceivedThresholds = {
  withdraw_received_ratio_bp: DEFAULTS.withdraw_received_ratio_bp,
};

function orders(count: number, fact: CommissionFact): CommissionFact[] {
  return Array.from({ length: count }, () => ({ ...fact }));
}
const HIGH: CommissionFact = { est_commission_fen: 60n, commission_base_fen: 100n }; // 6000 bp
const LOW: CommissionFact = { est_commission_fen: 10n, commission_base_fen: 100n }; // 1000 bp

it.each([
  {
    label: 'BR 例：10 单 4 单失效 → 4000bp > 3000 且 4 ≥ 3',
    counts: [10, 4],
    t: IR,
    want: [4000, 3000],
  },
  { label: '恰好 3000bp 不命中', counts: [10, 3], t: IR, want: null },
  { label: '3010bp 命中', counts: [1000, 301], t: IR, want: [3010, 3000] },
  { label: '9 单 3 单：3333bp（向下取整）', counts: [9, 3], t: IR, want: [3333, 3000] },
  {
    label: '精确比较：3/9 > 3333bp，取整值等于阈值仍命中',
    counts: [9, 3],
    t: { invalid_ratio_bp: 3333, invalid_min_count: 3 },
    want: [3333, 3333],
  },
  {
    label: '精确比较：1/3 > 3333bp',
    counts: [3, 1],
    t: { invalid_ratio_bp: 3333, invalid_min_count: 1 },
    want: [3333, 3333],
  },
  { label: '4000bp 但只 2 单 < 3', counts: [5, 2], t: IR, want: null },
  { label: '3 单全部失效', counts: [3, 3], t: IR, want: [10000, 3000] },
  { label: '分母 0 不命中', counts: [0, 0], t: IR, want: null },
  {
    label: '阈值参数 3999 命中',
    counts: [10, 4],
    t: { invalid_ratio_bp: 3999, invalid_min_count: 3 },
    want: [4000, 3999],
  },
  {
    label: '阈值参数 4000 不命中',
    counts: [10, 4],
    t: { invalid_ratio_bp: 4000, invalid_min_count: 3 },
    want: null,
  },
  {
    label: '最少单数参数 4 命中',
    counts: [10, 4],
    t: { invalid_ratio_bp: 3000, invalid_min_count: 4 },
    want: [4000, 3000],
  },
  {
    label: '最少单数参数 5 不命中',
    counts: [10, 4],
    t: { invalid_ratio_bp: 3000, invalid_min_count: 5 },
    want: null,
  },
] as const)('[AC-B2-11a#1] ④ invalid_ratio_60d：$label', ({ counts, t, want }) => {
  const [total, invalid] = counts;
  expect(invalidRatioFlag({ orders: total, invalid }, t)).toEqual(
    want === null ? null : flag('invalid_ratio_60d', want[0], want[1]),
  );
});

it('[AC-B2-11a#2] ④ 性质：命中当且仅当 分子×10000 > 阈值×分母 且 分子 ≥ 最少单数；value 为向下取整 bp', () => {
  fc.assert(
    fc.property(
      fc
        .integer({ min: 0, max: 100000 })
        .chain((total) => fc.tuple(fc.constant(total), fc.integer({ min: 0, max: total }))),
      fc.integer({ min: 0, max: 20000 }),
      fc.integer({ min: 0, max: 50 }),
      ([total, invalid], bp, min) => {
        const hit =
          total > 0 && BigInt(invalid) * 10000n > BigInt(bp) * BigInt(total) && invalid >= min;
        const want = hit
          ? flag('invalid_ratio_60d', Number((BigInt(invalid) * 10000n) / BigInt(total)), bp)
          : null;
        return same(
          invalidRatioFlag(
            { orders: total, invalid },
            { invalid_ratio_bp: bp, invalid_min_count: min },
          ),
          want,
        );
      },
    ),
    propParams(),
  );
});

it.each([
  [50n, 100n, 5000],
  [1n, 3n, 3333],
  [2n, 3n, 6666],
  [49999n, 100000n, 4999],
  [0n, 100n, 0],
  [300n, 100n, 30000],
  [5n, 0n, null],
  [5n, -1n, null],
] as const)(
  '[AC-B2-11a#3] ⑤ 单笔佣金率 = 预估佣金 %s × 10000 / 计佣金额 %s 向下取整 → %s（计佣金额非正无定义）',
  (est, base, want) => {
    expect(commissionRateBp(est, base)).toBe(want);
  },
);

it.each([
  { label: 'BR 例：4 单全部 ≥50%，分母 4 < 5 不计', list: orders(4, HIGH), t: HC, want: null },
  {
    label: '最少单数参数 4：4 单全高佣 → 10000bp',
    list: orders(4, HIGH),
    t: { ...HC, min_orders: 4 },
    want: [10000, 5000],
  },
  {
    label: '5 单 3 高佣 → 6000bp',
    list: [...orders(3, HIGH), ...orders(2, LOW)],
    t: HC,
    want: [6000, 5000],
  },
  { label: '恰好 5000bp 不命中', list: [...orders(5, HIGH), ...orders(5, LOW)], t: HC, want: null },
  {
    label: '10 单 6 高佣 → 6000bp',
    list: [...orders(6, HIGH), ...orders(4, LOW)],
    t: HC,
    want: [6000, 5000],
  },
  {
    label: '单笔佣金率恰好 5000bp 算高佣（≥）',
    list: orders(5, { est_commission_fen: 50n, commission_base_fen: 100n }),
    t: HC,
    want: [10000, 5000],
  },
  {
    label: '单笔 4999bp 不算高佣',
    list: orders(5, { est_commission_fen: 4999n, commission_base_fen: 10000n }),
    t: HC,
    want: null,
  },
  {
    label: '单笔 4999.99bp 向下取整为 4999，不算高佣',
    list: orders(5, { est_commission_fen: 49999n, commission_base_fen: 100000n }),
    t: HC,
    want: null,
  },
  {
    label: '计佣金额 0 的单计入分母、不计入分子',
    list: [...orders(4, HIGH), { est_commission_fen: 10n, commission_base_fen: 0n }],
    t: HC,
    want: [8000, 5000],
  },
  {
    label: '计佣金额缺失的单计入分母、不计入分子',
    list: [...orders(4, HIGH), { est_commission_fen: 10n, commission_base_fen: null }],
    t: HC,
    want: [8000, 5000],
  },
  {
    label: '预估佣金缺失的单计入分母、不计入分子',
    list: [...orders(4, HIGH), { est_commission_fen: null, commission_base_fen: 100n }],
    t: HC,
    want: [8000, 5000],
  },
  {
    label: '精确比较：4/7 > 5714bp，取整值等于阈值仍命中',
    list: [...orders(4, HIGH), ...orders(3, LOW)],
    t: { ...HC, high_commission_ratio_bp: 5714 },
    want: [5714, 5714],
  },
  {
    label: '单笔阈值参数 6001：6000bp 的单不算高佣',
    list: orders(10, HIGH),
    t: { ...HC, high_commission_rate_bp: 6001 },
    want: null,
  },
  {
    label: '单笔阈值参数 6000：6000bp 的单算高佣',
    list: orders(10, HIGH),
    t: { ...HC, high_commission_rate_bp: 6000 },
    want: [10000, 5000],
  },
  { label: '无订单', list: [], t: HC, want: null },
] as const)('[AC-B2-11a#4] ⑤ high_commission_ratio_60d：$label', ({ list, t, want }) => {
  expect(highCommissionRatioFlag(list, t)).toEqual(
    want === null ? null : flag('high_commission_ratio_60d', want[0], want[1]),
  );
});

it('[AC-B2-11a#5] ⑤ 性质：分母 = 全部单、分子 = 计佣金额 > 0 且向下取整佣金率 ≥ 单笔阈值；分母 ≥ 最少单数且精确比较 >', () => {
  const fact = fc.record({
    est_commission_fen: fc.option(fc.bigInt({ min: 0n, max: 2000n }), { nil: null }),
    commission_base_fen: fc.option(fc.bigInt({ min: 0n, max: 2000n }), { nil: null }),
  });
  fc.assert(
    fc.property(
      fc.array(fact, { maxLength: 40 }),
      fc.integer({ min: 0, max: 20000 }),
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: 0, max: 50 }),
      (list, rate, ratio, min) => {
        const total = list.length;
        const high = list.filter(
          (o) =>
            o.est_commission_fen !== null &&
            o.commission_base_fen !== null &&
            o.commission_base_fen > 0n &&
            (o.est_commission_fen * 10000n) / o.commission_base_fen >= BigInt(rate),
        ).length;
        const hit =
          total > 0 && total >= min && BigInt(high) * 10000n > BigInt(ratio) * BigInt(total);
        const want = hit
          ? flag(
              'high_commission_ratio_60d',
              Number((BigInt(high) * 10000n) / BigInt(total)),
              ratio,
            )
          : null;
        return same(
          highCommissionRatioFlag(list, {
            high_commission_rate_bp: rate,
            high_commission_ratio_bp: ratio,
            min_orders: min,
          }),
          want,
        );
      },
    ),
    propParams(),
  );
});

it.each([
  { label: 'BR 例：¥500 / ¥320 → 15625bp', w: 50000n, r: 32000n, t: WR, want: [15625, 10000] },
  { label: 'BR 例：分母 0 命中，value 为 null', w: 1000n, r: 0n, t: WR, want: [null, 10000] },
  { label: '恰好 10000bp 不命中', w: 10000n, r: 10000n, t: WR, want: null },
  { label: '10001bp 命中', w: 10001n, r: 10000n, t: WR, want: [10001, 10000] },
  {
    label: '精确比较：15000.5bp > 15000，取整值等于阈值仍命中',
    w: 30001n,
    r: 20000n,
    t: { withdraw_received_ratio_bp: 15000 },
    want: [15000, 15000],
  },
  {
    label: '恰好等于参数阈值 15000 不命中',
    w: 30000n,
    r: 20000n,
    t: { withdraw_received_ratio_bp: 15000 },
    want: null,
  },
  {
    label: '分母 0 无论阈值多大都命中',
    w: 1n,
    r: 0n,
    t: { withdraw_received_ratio_bp: 999999 },
    want: [null, 999999],
  },
] as const)('[AC-B2-11a#6] ⑥ withdraw_vs_received：$label', ({ w, r, t, want }) => {
  expect(withdrawVsReceivedFlag({ withdrawn_fen: w, received_fen: r }, t)).toEqual(
    want === null ? null : flag('withdraw_vs_received', want[0], want[1]),
  );
});

// Amounts up to 2^53 − 1 fen (well past 2^31); pairs whose bp would exceed Number.MAX_SAFE_INTEGER
// are skipped (value is a JSON-safe integer bp).
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const fen = (min: bigint) => fc.bigInt({ min, max: SAFE });

it('[AC-B2-11a#7] ⑥ 性质：分母 0 命中（value null）；否则命中当且仅当 分子×10000 > 阈值×分母，value 为向下取整 bp', () => {
  fc.assert(
    fc.property(
      fen(1n),
      fc.oneof({ arbitrary: fc.constant(0n), weight: 1 }, { arbitrary: fen(1n), weight: 9 }),
      fc.integer({ min: 0, max: 100000 }),
      (withdrawn, received, bp) => {
        fc.pre(received === 0n || (withdrawn * 10000n) / received <= SAFE);
        const want =
          received === 0n
            ? flag('withdraw_vs_received', null, bp)
            : withdrawn * 10000n > BigInt(bp) * received
              ? flag('withdraw_vs_received', Number((withdrawn * 10000n) / received), bp)
              : null;
        return same(
          withdrawVsReceivedFlag(
            { withdrawn_fen: withdrawn, received_fen: received },
            { withdraw_received_ratio_bp: bp },
          ),
          want,
        );
      },
    ),
    propParams(),
  );
});

it('[AC-B2-11a#7] ⑥ 超过 2^31 的金额按整数精确比较', () => {
  // 2^40 + 1 over 2^40: 10000.0000…bp > 10000 although the floored value equals the threshold.
  expect(
    withdrawVsReceivedFlag(
      { withdrawn_fen: 2n ** 40n + 1n, received_fen: 2n ** 40n },
      { withdraw_received_ratio_bp: 10000 },
    ),
  ).toEqual(flag('withdraw_vs_received', 10000, 10000));
  expect(
    withdrawVsReceivedFlag(
      { withdrawn_fen: 2n ** 52n, received_fen: 2n ** 52n },
      { withdraw_received_ratio_bp: 10000 },
    ),
  ).toBeNull();
});
