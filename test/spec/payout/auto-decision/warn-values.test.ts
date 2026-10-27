// B2-11b the three ⑧ actual values (规划/08 BR-WDR-30 细则 ⑧, computed with the BR-WDR-29 ④⑤⑥
// windows and numerators / denominators) and their effect through decideAutoPayout:
//   high commission = orders with rate > X (not ≥) × 10000 / orders; invalid = invalid orders
//   × 10000 / orders (the same denominator, BR-WDR-29 ⑤「分母同 ④」); withdraw / received =
//   withdrawn_30d × 10000 / received_60d;
//   no minimum order count (min_orders) and no minimum invalid count (invalid_min_count);
//   denominator 0 → null (high commission and invalid do not hit, withdraw / received hits);
//   Y, Z, W only switch their item off at 0 in the engine, they never change the values;
//   the rule compares the exact numerator × 10000 / denominator with '>', so a value between two
//   whole bp is rounded up (an integer v satisfies v > T ⇔ exact > T for every integer T only when
//   v = ⌈exact⌉).
import { expect, it } from 'vitest';
import {
  computeAutoPayoutWarnValues,
  decideAutoPayout,
  type AutoPayoutConfig,
  type AutoPayoutWarnOrder,
  type AutoPayoutWarnSource,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { defaults, passing } from './kit.ts';

type Warn = AutoPayoutConfig['warn'];

function warn(patch: Partial<Warn> = {}): Warn {
  return { ...defaults().warn, ...patch };
}

function order(commission_rate_bp: number, invalid = false): AutoPayoutWarnOrder {
  return { commission_rate_bp, invalid };
}

function times(n: number, value: AutoPayoutWarnOrder): AutoPayoutWarnOrder[] {
  return Array.from({ length: n }, () => ({ ...value }));
}

function source(patch: Partial<AutoPayoutWarnSource> = {}): AutoPayoutWarnSource {
  return { orders_60d: [], withdrawn_30d_fen: 28000n, received_60d_fen: 56000n, ...patch };
}

/** passing() with the ⑧ values computed from `from` under `config` (the caller's sequence). */
function decideWith(from: AutoPayoutWarnSource, config: Warn) {
  const value = passing();
  value.config.warn = config;
  value.warn_actuals = computeAutoPayoutWarnValues(from, config);
  return decideAutoPayout(value);
}

it('[AC-B2-11b#53] ⑧ 单笔佣金率一律「> X」：等于 X 不计入分子，X+1 计入', () => {
  const x = warn({ high_commission_rate_bp: 5000 });
  const values = (rates: number[]) =>
    computeAutoPayoutWarnValues(source({ orders_60d: rates.map((r) => order(r)) }), x)
      .high_commission_order_ratio_bp;
  expect(values([5000])).toBe(0);
  expect(values([5001])).toBe(10000);
  expect(values([5000, 5001])).toBe(5000);
  expect(values([4999, 5000, 5001, 8000])).toBe(5000);
  // Default X = 10000: a rate of exactly 100% is not above it.
  const byDefault = computeAutoPayoutWarnValues(
    source({ orders_60d: [order(10000), order(10001)] }),
    warn(),
  );
  expect(byDefault.high_commission_order_ratio_bp).toBe(5000);
});

it('[AC-B2-11b#54] ⑧ 高佣占比不设最少单数：4 单全部 8000bp、X=5000 → 10000，Y=5000 时转人工', () => {
  const config = warn({ high_commission_rate_bp: 5000, high_commission_order_ratio_bp: 5000 });
  const from = source({ orders_60d: times(4, order(8000)) });
  expect(computeAutoPayoutWarnValues(from, config).high_commission_order_ratio_bp).toBe(10000);
  expect(decideWith(from, config)).toMatchObject({
    result: 'manual',
    failed_conditions: ['warn_high_commission'],
    warn_values: { high_commission_order_ratio_bp: 10000 },
  });
  // A single order is a full denominator too.
  const one = source({ orders_60d: [order(8000)] });
  expect(computeAutoPayoutWarnValues(one, config).high_commission_order_ratio_bp).toBe(10000);
  // The same 4 orders exactly at X are not above it: 0 → auto.
  const atX = source({ orders_60d: times(4, order(5000)) });
  expect(decideWith(atX, config)).toMatchObject({
    result: 'auto',
    failed_conditions: [],
    warn_values: { high_commission_order_ratio_bp: 0 },
  });
});

it('[AC-B2-11b#55] ⑧ 失效占比不设最少失效单数：10 单 2 单失效 → 2000，Z=1999 时转人工', () => {
  const orders = [...times(2, order(1000, true)), ...times(8, order(1000))];
  const config = warn({ invalid_ratio_bp: 1999 });
  const from = source({ orders_60d: orders });
  expect(computeAutoPayoutWarnValues(from, config).invalid_ratio_bp).toBe(2000);
  expect(decideWith(from, config)).toMatchObject({
    result: 'manual',
    failed_conditions: ['warn_invalid_ratio'],
    warn_values: { invalid_ratio_bp: 2000 },
  });
  expect(decideWith(from, warn({ invalid_ratio_bp: 2000 }))).toMatchObject({
    result: 'auto',
    failed_conditions: [],
  });
  const single = source({ orders_60d: [order(1000, true)] });
  expect(computeAutoPayoutWarnValues(single, config).invalid_ratio_bp).toBe(10000);
});

it('[AC-B2-11b#56] ⑧ 细则例：60 天 10 单 4 单失效 → 4000；30 天提现 ¥500 / 60 天确认收货 ¥320 → 15625', () => {
  const from = source({
    orders_60d: [...times(4, order(2000, true)), ...times(6, order(2000))],
    withdrawn_30d_fen: 50000n,
    received_60d_fen: 32000n,
  });
  expect(computeAutoPayoutWarnValues(from, warn({ high_commission_rate_bp: 5000 }))).toEqual({
    high_commission_order_ratio_bp: 0,
    invalid_ratio_bp: 4000,
    withdraw_received_ratio_bp: 15625,
  });
});

it('[AC-B2-11b#57] ⑧ 高佣与失效同一分母：失效单照样参与高佣占比，高佣单照样参与失效占比', () => {
  const from = source({ orders_60d: [order(8000, true), order(1000), order(9000), order(0)] });
  expect(computeAutoPayoutWarnValues(from, warn({ high_commission_rate_bp: 5000 }))).toMatchObject({
    high_commission_order_ratio_bp: 5000,
    invalid_ratio_bp: 2500,
  });
});

it('[AC-B2-11b#58] ⑧ 提现额 / 确认收货佣金：等于 W 不命中，多 1 分即命中（按精确比较）', () => {
  const equal = source({ withdrawn_30d_fen: 32000n, received_60d_fen: 32000n });
  expect(computeAutoPayoutWarnValues(equal, warn()).withdraw_received_ratio_bp).toBe(10000);
  const config = warn({ withdraw_received_ratio_bp: 10000 });
  expect(decideWith(equal, config)).toMatchObject({ result: 'auto', failed_conditions: [] });
  // 32001 × 10000 / 32000 = 10000.3125 > 10000.
  const over = source({ withdrawn_30d_fen: 32001n, received_60d_fen: 32000n });
  expect(computeAutoPayoutWarnValues(over, config).withdraw_received_ratio_bp).toBe(10001);
  expect(decideWith(over, config)).toMatchObject({
    result: 'manual',
    failed_conditions: ['warn_withdraw_received'],
  });
});

it('[AC-B2-11b#59] ⑧ 分母为 0 → null：无 60 天订单时高佣与失效不命中，无确认收货佣金时提现额项命中', () => {
  const from = source({ orders_60d: [], withdrawn_30d_fen: 1000n, received_60d_fen: 0n });
  const config = warn({
    high_commission_rate_bp: 0,
    high_commission_order_ratio_bp: 1,
    invalid_ratio_bp: 1,
    withdraw_received_ratio_bp: 10000,
  });
  expect(computeAutoPayoutWarnValues(from, config)).toEqual({
    high_commission_order_ratio_bp: null,
    invalid_ratio_bp: null,
    withdraw_received_ratio_bp: null,
  });
  expect(decideWith(from, config)).toEqual({
    result: 'manual',
    failed_conditions: ['warn_withdraw_received'],
    warn_values: {
      high_commission_order_ratio_bp: null,
      invalid_ratio_bp: null,
      withdraw_received_ratio_bp: null,
    },
  });
  // Default W = 0 switches the item off: the same member auto-pays (细则 BR-WDR-29 例：首提 ¥10).
  expect(decideWith(from, warn())).toMatchObject({ result: 'auto', failed_conditions: [] });
});

it('[AC-B2-11b#60] ⑧ 非整 bp 的占比向上取整：1/3 失效 → 3334，Z=3333 命中、Z=3334 不命中', () => {
  const thirds = source({
    orders_60d: [order(9000, true), order(9000), order(0)],
    withdrawn_30d_fen: 1n,
    received_60d_fen: 3n,
  });
  expect(computeAutoPayoutWarnValues(thirds, warn({ high_commission_rate_bp: 5000 }))).toEqual({
    high_commission_order_ratio_bp: 6667,
    invalid_ratio_bp: 3334,
    withdraw_received_ratio_bp: 3334,
  });
  expect(decideWith(thirds, warn({ invalid_ratio_bp: 3333 }))).toMatchObject({
    failed_conditions: ['warn_invalid_ratio'],
  });
  expect(decideWith(thirds, warn({ invalid_ratio_bp: 3334 }))).toMatchObject({
    failed_conditions: [],
  });
  const high = warn({ high_commission_rate_bp: 5000, high_commission_order_ratio_bp: 6666 });
  expect(decideWith(thirds, high)).toMatchObject({ failed_conditions: ['warn_high_commission'] });
  expect(decideWith(thirds, warn({ withdraw_received_ratio_bp: 3333 }))).toMatchObject({
    failed_conditions: ['warn_withdraw_received'],
  });
});

it('[AC-B2-11b#61] ⑧ 金额按 bigint 精确计算：超过 2^53 分时多 1 分也算超过', () => {
  const big = 2n ** 53n;
  const equal = source({ withdrawn_30d_fen: big, received_60d_fen: big });
  expect(computeAutoPayoutWarnValues(equal, warn()).withdraw_received_ratio_bp).toBe(10000);
  const over = source({ withdrawn_30d_fen: big + 1n, received_60d_fen: big });
  expect(computeAutoPayoutWarnValues(over, warn()).withdraw_received_ratio_bp).toBe(10001);
  expect(decideWith(over, warn({ withdraw_received_ratio_bp: 10000 }))).toMatchObject({
    failed_conditions: ['warn_withdraw_received'],
  });
});

it('[AC-B2-11b#62] ⑧ Y、Z、W 不改变实际值；X=0 不是关闭，佣金率 > 0 的单都计入', () => {
  const from = source({
    orders_60d: [order(0), order(1, true), order(6000), order(10000, true)],
    withdrawn_30d_fen: 50000n,
    received_60d_fen: 40000n,
  });
  const expected = {
    high_commission_order_ratio_bp: 5000,
    invalid_ratio_bp: 5000,
    withdraw_received_ratio_bp: 12500,
  };
  for (const [y, z, w] of [
    [0, 0, 0],
    [1, 1, 1],
    [5000, 3000, 10000],
    [10000, 10000, 10000],
  ] as const) {
    const config = warn({
      high_commission_rate_bp: 5000,
      high_commission_order_ratio_bp: y,
      invalid_ratio_bp: z,
      withdraw_received_ratio_bp: w,
    });
    expect(computeAutoPayoutWarnValues(from, config)).toEqual(expected);
  }
  const zero = computeAutoPayoutWarnValues(from, warn({ high_commission_rate_bp: 0 }));
  expect(zero.high_commission_order_ratio_bp).toBe(7500);
});

it('[AC-B2-11b#63] ⑧ 按默认值（X=10000、Y=Z=10000、W=0）即使全部高佣且失效、提现远超收货佣金也不命中', () => {
  const from = source({
    orders_60d: times(5, order(10000, true)),
    withdrawn_30d_fen: 30000n,
    received_60d_fen: 100n,
  });
  expect(decideWith(from, warn())).toEqual({
    result: 'auto',
    failed_conditions: [],
    warn_values: {
      high_commission_order_ratio_bp: 0,
      invalid_ratio_bp: 10000,
      withdraw_received_ratio_bp: 3_000_000,
    },
  });
});
